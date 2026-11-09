import { expect, test } from 'claude-code/testing'

import {
  addressOf, frameMessages, isLive, LIVE_MS, mayWake, messageFileName,
  pendingNames, profileName, resolveTarget, SHOW_TEXT, showMessages, toolResultCount, toolUseCount,
  chooseOpenIn, editorFor, EDITORS, helperInstall, findOpened, isSafeLaunch, launchFor, trustProject, vscodeLink, windowArgv, withLaunchFlags,
  linuxArgv, linuxCandidates, macArgv, parseOpenArgs, shQuote, userShell, whichArgv,
  appDataFolders, appTitle, cleanTitle, labelOf, listLine, projectFolderName, transcriptTitle,
} from '../hooks/core.mjs'
import {
  configDirsInShell, hasLauncher, homeCandidates, isSafeFolder, isSafeName, looksLikeProfile, mergeBlock, nameTaken,
  providerHost, shortcutBlock, shortcutsIn,
} from '../hooks/setup.mjs'

const NOW = 1_000_000
const rec = (id: string, profile: string, address: string, seenAt = NOW) => ({ id, profile, address, seenAt, cwd: 'x' })

test('a profile is named from its config folder', async () => {
  expect(profileName(undefined, 'C:\\Users\\me\\.claude', undefined)).toBe('default')
  expect(profileName(undefined, 'C:\\Users\\me\\.claude-work', undefined)).toBe('work')
  expect(profileName(undefined, '/home/me/.claude-glm/', undefined)).toBe('glm')
  expect(profileName(undefined, '/home/me/My Claude', undefined)).toBe('my-claude')
})

test('a name set by hand wins, and an unset config folder falls back', async () => {
  expect(profileName('  DeepSeek ', 'C:\\Users\\me\\.claude-work', undefined)).toBe('deepseek')
  expect(profileName(undefined, undefined, 'C:\\Users\\me\\.claude-work\\plugins\\cache\\x')).toBe('work')
  expect(profileName(undefined, undefined, '/home/me/.claude/plugins/cache/x')).toBe('default')
  expect(profileName(undefined, undefined, undefined)).toBe('default')
})

test('an address is readable and carries the session', async () => {
  expect(addressOf('work', 'C:\\code\\My Web_App', 'ab12-cd34')).toBe('work/my-web-app-ab12')
})

test('a session stops being live when it ends or goes quiet', async () => {
  expect(isLive({ seenAt: NOW }, NOW + LIVE_MS - 1)).toBe(true)
  expect(isLive({ seenAt: NOW }, NOW + LIVE_MS)).toBe(false)
  expect(isLive({ seenAt: NOW, endedAt: NOW }, NOW)).toBe(false)
})

test('who a message is for', async () => {
  const all = [rec('me', 'work', 'work/a-1'), rec('p1', 'personal', 'personal/b-2'), rec('g1', 'glm', 'glm/c-3'), rec('g2', 'glm', 'glm/d-4'), rec('old', 'old', 'old/e-5', NOW - LIVE_MS)]
  expect(resolveTarget('personal', all, 'me', NOW).record?.id).toBe('p1')
  expect(resolveTarget('GLM/D-4', all, 'me', NOW).record?.id).toBe('g2')
  expect(resolveTarget('c-3', all, 'me', NOW).record?.id).toBe('g1')
  expect(resolveTarget('p1', all, 'me', NOW).record?.address).toBe('personal/b-2')
  expect(resolveTarget('glm', all, 'me', NOW).error).toMatch(/could be several.*glm\/c-3, glm\/d-4/)
  expect(resolveTarget('work', all, 'me', NOW).error).toMatch(/No running session/) // never itself
  expect(resolveTarget('old', all, 'me', NOW).error).toMatch(/No running session/) // never one that has gone
  expect(resolveTarget('', all, 'me', NOW).error).toMatch(/Say who/)
})

test('an inbox gives what is new, oldest first, and leaves the ledger out', async () => {
  const f = (name: string, kind = 'file') => ({ name, kind })
  const a = messageFileName(5, 'a')
  const b = messageFileName(40, 'b')
  const c = messageFileName(300, 'c')
  expect(pendingNames([f(c), f(a), f(b), f('_delivered.json'), f('note.txt'), f('dir.json', 'directory')], new Set([b]))).toEqual([a, c])
})

test('a message is framed as not being from the person', async () => {
  const text = frameMessages([{ from: 'personal/x-1', sentAt: 0, text: 'hello there' }])
  expect(text).toMatch(/From personal\/x-1/)
  expect(text).toMatch(/hello there/)
  expect(text).toMatch(/not what the person typed/)
  expect(text).toMatch(/does not give the person's approval/)
  expect(text).toMatch(/already been shown this message/)
})

test('the person is shown who a message is from and all of it, or where the rest is', async () => {
  const shown = showMessages([{ from: 'zai/x-1', sentAt: NOW, text: 'hello there', name: 'a.json' }], 'C:/box/inbox/me')
  expect(shown).toMatch(/^Crosstalk ← zai\/x-1 · \d\d:\d\d\nhello there$/)
  const long = showMessages([{ from: 'zai/x-1', sentAt: NOW, text: 'y'.repeat(SHOW_TEXT + 50), name: 'a.json' }], 'C:/box/inbox/me')
  expect(long).toMatch(/y… \(cut; the whole message is in C:\/box\/inbox\/me\/a\.json\)$/)
  expect(long.length).toBeLessThan(2000)
})

test('wake-ups stop at the limit', async () => {
  expect(mayWake(24, 25)).toBe(true)
  expect(mayWake(25, 25)).toBe(false)
})

test('tool calls and results are counted, so a message never lands between them', async () => {
  const response = [{ type: 'text', text: 'x' }, { type: 'tool_use' }, { type: 'tool_use' }]
  expect(toolUseCount(response)).toBe(2)
  expect(toolResultCount([{ type: 'tool_result' }])).toBe(1)
  expect(toolUseCount('plain')).toBe(0)
})

// The mod itself, with a folder in memory standing for the disk. On Windows the host hands paths
// over in Windows spelling, and may add a drive to a Unix path. On macOS and Linux a Windows path
// isn't absolute, so the host puts the working folder in front of it: that part is dropped.
const slash = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=(?<![A-Za-z])[A-Za-z]:\/)/, '').replace(/^[A-Za-z]:(?=\/home\/me)/, '')

const RAN_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

function fakeDisk(on: any, env: Record<string, string> = { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work' }, run: (e: any, files: Map<string, string>) => any = () => RAN_OK) {
  const files: any = new Map<string, string>()
  on('env.get', (_: any, e: any) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'self-1' }))
  on('session.cwd', () => ({ value: 'C:\\code\\proj' }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__crosstalk__${e.name}` } }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('fs.write', (_: any, e: any) => { files.set(slash(e.path), e.text); return { value: undefined } })
  on('fs.read', (_: any, e: any) => {
    if (!files.has(slash(e.path))) throw new Error('ENOENT')
    return { value: files.get(slash(e.path)) }
  })
  on('fs.list', (_: any, e: any) => {
    const prefix = `${slash(e.path)}/`
    const rests = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
    if (rests.length === 0 && !(files as any).folders?.includes(slash(e.path))) throw new Error('ENOENT')
    const names = [...new Set(rests.map((r) => r.split('/')[0]))]
    return { value: names.map((name) => ({ name, kind: rests.includes(name) ? 'file' : 'dir', size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.exists', (_: any, e: any) => ({ value: files.has(slash(e.path)) }))
  // A file's time is its length here, so a file that grows has changed.
  on('fs.stat', (_: any, e: any) => {
    if (!files.has(slash(e.path))) throw new Error('ENOENT')
    const size = files.get(slash(e.path)).length
    return { value: { kind: 'file', size, mtimeMs: size, isLink: false } }
  })
  on('process.run', (_: any, e: any) => ({ value: run(e, files) }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  files.logs = [] as string[]
  on('ui.log', (_: any, e: any) => { files.logs.push(e.text); return { value: undefined } })
  on('clock.now', () => ({ value: NOW }))
  // Polling runs when a test says so; everything else never ticks.
  on('clock.every', (_: any, e: any) => new Promise<any>((resolve) => {
    if (e.ms === 3000) (files as any).tick = () => resolve({ value: undefined })
    if (e.ms === 15000) (files as any).beat = () => resolve({ value: undefined })
  }))
  return files
}

const BOX = 'C:/home/.claude-crosstalk'
const START = { cwd: 'C:\\code\\proj', surface: 'terminal', isInteractive: true } as const
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test('it registers the session under its profile and sends to another', async ($, on) => {
  const files = fakeDisk(on)
  await $.session.start(START)
  const mine = JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!)
  expect(mine.address).toBe('work/proj-self')

  files.set(`${BOX}/sessions/other.json`, JSON.stringify({ id: 'other', profile: 'personal', address: 'personal/x-oth', cwd: 'y', seenAt: NOW }))
  const sent: any = await $.tool.call({ tool: 'mcp__crosstalk__send', to: 'personal', text: 'hi' } as never)
  expect(JSON.stringify(sent)).toMatch(/Sent to personal\/x-oth/)
  const written = [...files.keys()].find((k) => k.startsWith(`${BOX}/inbox/other/`))!
  expect(JSON.parse(files.get(written)!).text).toBe('hi')
  expect(JSON.parse(files.get(written)!).from).toBe('work/proj-self')
})

test('the folder and the name can be set by hand', async ($, on) => {
  const files = fakeDisk(on, { HOME: '/home/me', CLAUDE_CROSSTALK_DIR: '/shared/box/', CLAUDE_CROSSTALK_NAME: 'deepseek' })
  await $.session.start(START)
  const record = [...files.keys()].find((k) => k.endsWith('/shared/box/sessions/self-1.json'))! // the host may add a drive
  expect(JSON.parse(files.get(record)!).address).toBe('deepseek/proj-self')
})

test('sending to nobody says who there is and writes nothing', async ($, on) => {
  const files = fakeDisk(on)
  await $.session.start(START)
  const sent: any = await $.tool.call({ tool: 'mcp__crosstalk__send', to: 'glm', text: 'hi' } as never)
  expect(JSON.stringify(sent)).toMatch(/No running session/)
  expect([...files.keys()].some((k) => k.includes('/inbox/'))).toBe(false)
})

test('an idle session is woken by a message, once, and the ledger remembers it', async ($, on) => {
  const files: any = fakeDisk(on)
  const submitted: string[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text, origin: e.origin } })
  await $.session.start(START)
  files.set(`${BOX}/inbox/self-1/${messageFileName(NOW, 'a')}`, JSON.stringify({ from: 'personal/x-oth', sentAt: NOW, text: 'wake up' }))
  files.tick()
  await settle()
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toMatch(/From personal\/x-oth/)
  expect(submitted[0]).toMatch(/wake up/)
  expect(JSON.parse(files.get(`${BOX}/inbox/self-1/_delivered.json`))).toEqual([messageFileName(NOW, 'a')])
  expect(files.logs.length).toBe(1)
  expect(files.logs[0]).toMatch(/^Crosstalk ← personal\/x-oth[^\n]*\nwake up$/)
})

test('a message arriving mid-turn is shown once, after the last tool result', async ($, on) => {
  const files: any = fakeDisk(on)
  const rows: any[] = []
  on('session.append', (_: any, e: any, next: any) => { rows.push(e); return next(e) })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  await $.session.start(START)
  await $.turn.start({ turnId: 't1' } as never)
  files.set(`${BOX}/inbox/self-1/${messageFileName(NOW, 'a')}`, JSON.stringify({ from: 'zai/x-oth', sentAt: NOW, text: 'mid-turn hello' }))
  await $.session.append({ door: 'response', message: { type: 'assistant', content: [{ type: 'tool_use' }] } } as never)
  expect(files.logs.length).toBe(0)
  await $.session.append({ door: 'tool-result', message: { type: 'user', content: [{ type: 'tool_result' }] } } as never)
  await settle()
  expect(files.logs.length).toBe(1)
  expect(files.logs[0]).toMatch(/mid-turn hello/)
  expect(rows.some((r) => JSON.stringify(r.message ?? '').includes('already been shown'))).toBe(true)
})

test('a half-written message is left for the next look', async ($, on) => {
  const files: any = fakeDisk(on)
  const submitted: string[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text, origin: e.origin } })
  await $.session.start(START)
  files.set(`${BOX}/inbox/self-1/${messageFileName(NOW, 'a')}`, '{"from":"per')
  files.tick()
  await settle()
  expect(submitted.length).toBe(0)
  expect(files.has(`${BOX}/inbox/self-1/_delivered.json`)).toBe(false)
})

// Setup: people's profiles are laid out differently, so each way of finding one is held here.
const HOME_ENV = { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude' }
const PS = 'C:/home/Documents/PowerShell/Microsoft.PowerShell_profile.ps1'
const seed = (files: Map<string, string>, folder: string, extra: Record<string, string> = {}) => {
  files.set(`${folder}/settings.json`, '{}')
  for (const [k, v] of Object.entries(extra)) files.set(`${folder}/${k}`, v)
}
const INSTALLED = JSON.stringify({ plugins: { 'crosstalk@claude-crosstalk': [{}] } })

// pwsh says where its profile is; `claude plugin install` writes the record a real one would.
function computerRun(calls: any[], policy = 'RemoteSigned', installs = true) {
  return (e: any, files: Map<string, string>) => {
    calls.push(e)
    if (e.argv[0] === 'pwsh') return { ...RAN_OK, stdout: `${PS.replace(/\//g, '\\')}\r\n${policy}\r\n` }
    if (e.argv[0] === 'powershell') throw new Error('not found')
    if (e.argv.includes('plugin')) {
      if (!installs) return { ...RAN_OK, exitCode: 1 }
      files.set(`${slash(e.init.env.CLAUDE_CONFIG_DIR)}/plugins/installed_plugins.json`, INSTALLED)
    }
    return RAN_OK
  }
}
const say = async ($: any, args: string) => (await $.command.run({ command: 'crosstalk', args })).text as string
const installsIn = (calls: any[]) => calls.filter((c) => c.argv.includes('plugin')).map((c) => slash(c.init.env.CLAUDE_CONFIG_DIR))

test('home folders are told apart from what is not a profile', async () => {
  const d = (name: string, kind = 'dir', isLink = false) => ({ name, kind, isLink })
  expect(homeCandidates([d('.claude'), d('.claude-work'), d('.claude-crosstalk'), d('.claude.json', 'file'), d('.claude-link', 'other', true), d('claude-shared'), d('.config')]))
    .toEqual(['.claude', '.claude-work', '.claude-link'])
  expect(looksLikeProfile([{ name: 'projects' }])).toBe(true)
  expect(looksLikeProfile([{ name: 'notes.txt' }])).toBe(false)
})

test('a launcher in a shell file is read for its folder, however it is written', async () => {
  const dirs = (text: string, home = '/home/me') => configDirsInShell(text, home)
  expect(dirs('export CLAUDE_CONFIG_DIR=~/.claude-work')).toEqual(['/home/me/.claude-work'])
  expect(dirs('alias w="CLAUDE_CONFIG_DIR=$HOME/.claude-work claude"')).toEqual(['/home/me/.claude-work'])
  expect(dirs('CLAUDE_CONFIG_DIR=/opt/my-claude claude "$@"')).toEqual(['/opt/my-claude'])
  expect(dirs('export CLAUDE_CONFIG_DIR="/opt/my claude"')).toEqual(['/opt/my claude'])
  expect(dirs('$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-glm"', 'C:\\home')).toEqual(['C:/home/.claude-glm'])
  expect(dirs('CLAUDE_CONFIG_DIR=/c/profiles/glm claude', 'C:\\home')).toEqual(['C:/profiles/glm'])
  expect(dirs('# CLAUDE_CONFIG_DIR=/old')).toEqual([])
  expect(dirs('export CLAUDE_CONFIG_DIR="$1"')).toEqual([])
  expect(dirs('$env:CLAUDE_CONFIG_DIR = $was')).toEqual([])
  expect(dirs('if ($env:CLAUDE_CONFIG_DIR -ne "x") {}')).toEqual([])
})

test('nothing but a folder or a host comes out of what is read', async () => {
  const shell = 'export ANTHROPIC_AUTH_TOKEN=sk-secret\nexport CLAUDE_CONFIG_DIR=/opt/c'
  expect(JSON.stringify(configDirsInShell(shell, '/home/me'))).not.toMatch(/secret/)
  expect(providerHost(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/key-secret?t=secret', ANTHROPIC_AUTH_TOKEN: 'secret' } }))).toBe('api.z.ai')
  expect(providerHost('not json')).toBe('')
})

test('shortcuts go in a marked block, and writing them twice changes nothing', async () => {
  const work = { name: 'work', folder: 'C:/home/.claude-work' }
  for (const kind of ['powershell', 'posix']) {
    const once = mergeBlock('# mine\r\n', shortcutBlock(kind, [work]))
    expect(mergeBlock(once, shortcutBlock(kind, [work]))).toBe(once)
    expect(once.startsWith('# mine')).toBe(true)
    expect(shortcutsIn(once)).toEqual([work])
    expect(hasLauncher(once, work.folder, 'C:/home')).toBe(false) // its own block is no person's launcher
  }
  expect(hasLauncher('$env:CLAUDE_CONFIG_DIR = "C:\\HOME\\.claude-work"', work.folder, 'C:/home')).toBe(true)
})

test('a name already used in a shell file is noticed, and a bad name or folder is refused', async () => {
  expect(nameTaken('alias claude-work="x"', 'work')).toBe(true)
  expect(nameTaken('function claude-work { }', 'work')).toBe(true)
  expect(nameTaken('claude-work() { x; }', 'work')).toBe(true)
  expect(nameTaken('claude-workshop() { x; }', 'work')).toBe(false)
  expect(isSafeName('work_2')).toBe(true)
  expect(isSafeName('a;rm')).toBe(false)
  expect(isSafeName('default')).toBe(false)
  expect(isSafeFolder("C:/Users/O'Brien/.claude-x")).toBe(true)
  expect(isSafeFolder('/x/$(rm)')).toBe(false)
  expect(isSafeFolder('/x/"y')).toBe(false)
})

test('setup finds profiles every way, and changes nothing until told to', async ($, on) => {
  const calls: any[] = []
  const files: any = fakeDisk(on, HOME_ENV, computerRun(calls))
  seed(files, 'C:/home/.claude', { 'plugins/installed_plugins.json': INSTALLED })
  seed(files, 'C:/home/.claude-work')
  seed(files, 'C:/home/.claude-glm', { 'settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/anthropic' } }) })
  seed(files, 'D:/profiles/odd')
  files.set('C:/home/.claude-empty/notes.txt', 'x')
  files.set(PS, '$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-glm"\n$env:CLAUDE_CONFIG_DIR = "D:\\profiles\\odd"\n')
  await $.session.start(START)
  const before = JSON.stringify([...files.entries()])
  const text = await say($, 'setup')
  expect(text).toMatch(/found 4 Claude Code profiles/)
  expect(text).toMatch(/default: ~\/\.claude\n.*this session.*Crosstalk installed.*start with claude/)
  expect(text).toMatch(/work: ~\/\.claude-work\n.*your home folder.*needs Crosstalk.*claude-work \(new\)/)
  expect(text).toMatch(/glm: ~\/\.claude-glm\n.*uses api\.z\.ai.*start with your own command/)
  expect(text).toMatch(/odd: D:\/profiles\/odd\n.*start with your own command/)
  expect(text).not.toMatch(/empty/)
  expect(text).toMatch(/Nothing has changed yet/)
  expect(JSON.stringify([...files.entries()])).toBe(before)
  expect(installsIn(calls)).toEqual([])
})

test('setup yes installs where needed, adds only missing shortcuts, and a second run does nothing', async ($, on) => {
  const calls: any[] = []
  const files: any = fakeDisk(on, HOME_ENV, computerRun(calls))
  seed(files, 'C:/home/.claude', { 'plugins/installed_plugins.json': INSTALLED })
  seed(files, 'C:/home/.claude-work')
  seed(files, 'C:/home/.claude-glm')
  const mine = '$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-glm"\n'
  files.set(PS, mine)
  await $.session.start(START)
  const text = await say($, 'setup yes')
  expect(installsIn(calls).sort()).toEqual(['C:/home/.claude-glm', 'C:/home/.claude-work'])
  expect(calls.find((c) => c.argv.includes('plugin')).argv).toEqual(['claude', 'plugin', 'install', 'crosstalk', '--marketplace', 'svumo/claude-crosstalk'])
  expect(files.get(PS)).toMatch(/function claude-work /)
  expect(files.get(PS)).not.toMatch(/claude-glm \{/) // has its own launcher
  expect(files.get(PS).startsWith(mine)).toBe(true)
  expect(files.get(`${PS}.crosstalk-backup`)).toBe(mine)
  expect(text).toMatch(/log in the first time/)
  const after = files.get(PS)
  calls.length = 0
  expect(await say($, 'setup yes')).toMatch(/Nothing to do/)
  expect(files.get(PS)).toBe(after)
  expect(installsIn(calls)).toEqual([])
})

test('the list can be corrected by hand: a folder added, one left out, a name changed', async ($, on) => {
  const files: any = fakeDisk(on, HOME_ENV, computerRun([]))
  seed(files, 'C:/home/.claude')
  seed(files, 'C:/home/.claude-backup')
  seed(files, 'D:/my profiles/x')
  await $.session.start(START)
  expect(await say($, 'setup add "D:\\my profiles\\x" client')).toMatch(/client: D:\/my profiles\/x\n.*your list/)
  expect(await say($, 'setup add D:\\missing')).toMatch(/has to exist/)
  const left = await say($, 'setup skip backup')
  expect(left).toMatch(/Leaving out backup/)
  expect(left).not.toMatch(/backup: /)
  expect(await say($, 'setup skip nobody')).toMatch(/Names: default, client/)
  expect(await say($, 'setup name client acme')).toMatch(/acme: D:\/my profiles\/x/)
  expect(await say($, 'setup name acme default')).toMatch(/Usage/)
  expect(await say($, 'setup name acme x;y')).toMatch(/Usage/)
})

test('a name saved by setup is what a session goes by', async ($, on) => {
  const files = fakeDisk(on)
  files.set(`${BOX}/setup.json`, JSON.stringify({ names: { 'C:/home/.claude-work': 'acme' } }))
  await $.session.start(START)
  expect(JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!).address).toBe('acme/proj-self')
})

test('a failed install gives the line to run, and an unsafe shell file is left alone', async ($, on) => {
  const files: any = fakeDisk(on, HOME_ENV, computerRun([], 'RemoteSigned', false))
  seed(files, 'C:/home/.claude', { 'plugins/installed_plugins.json': INSTALLED })
  seed(files, 'C:/home/.claude-work')
  const utf16 = '\uFFFD\0m\0i\0n\0e\0'
  files.set(PS, utf16)
  await $.session.start(START)
  const text = await say($, 'setup yes')
  expect(text).toMatch(/Couldn't install on work/)
  expect(text).toMatch(/\$env:CLAUDE_CONFIG_DIR = "C:\\home\\\.claude-work"; claude plugin install/)
  expect(await say($, 'setup')).toMatch(/isn't saved as UTF-8/)
  expect(files.get(PS)).toBe(utf16)
  expect(files.has(`${PS}.crosstalk-backup`)).toBe(false)
})

test('where PowerShell runs no scripts, no profile is written, and the person is told how', async ($, on) => {
  const files: any = fakeDisk(on, HOME_ENV, computerRun([], 'Restricted'))
  seed(files, 'C:/home/.claude', { 'plugins/installed_plugins.json': INSTALLED })
  seed(files, 'C:/home/.claude-work')
  await $.session.start(START)
  const text = await say($, 'setup yes')
  expect(text).toMatch(/Set-ExecutionPolicy -Scope CurrentUser RemoteSigned/)
  expect(files.has(PS)).toBe(false)
})

test('on macOS or Linux, shortcuts go in the file of the shell in use', async ($, on) => {
  const calls: any[] = []
  const files: any = fakeDisk(on, { HOME: '/home/me', SHELL: '/bin/zsh', CLAUDE_CONFIG_DIR: '/home/me/.claude' }, computerRun(calls))
  seed(files, '/home/me/.claude', { 'plugins/installed_plugins.json': INSTALLED })
  seed(files, '/home/me/.claude-work')
  await $.session.start(START)
  await say($, 'setup yes')
  const zsh = [...files.keys()].find((k: string) => k.endsWith('/.zshrc'))!
  expect(files.get(zsh)).toMatch(/claude-work\(\) \{ CLAUDE_CONFIG_DIR="[^"]*\/home\/me\/\.claude-work" claude "\$@"; \}/)
  expect(calls.some((c) => c.argv[0] === 'pwsh')).toBe(false)
})

test('add makes a new profile with a shortcut, and refuses what is there or a bad name', async ($, on) => {
  const calls: any[] = []
  const files: any = fakeDisk(on, HOME_ENV, computerRun(calls))
  seed(files, 'C:/home/.claude', { 'plugins/installed_plugins.json': INSTALLED })
  seed(files, 'C:/home/.claude-old')
  await $.session.start(START)
  const text = await say($, 'add Work')
  expect(installsIn(calls)).toEqual(['C:/home/.claude-work'])
  expect(files.get(PS)).toMatch(/function claude-work /)
  expect(text).toMatch(/run claude-work.*log in/)
  expect(await say($, 'add old')).toMatch(/already there/)
  expect(await say($, 'add a;b')).toMatch(/Usage/)
  expect(await say($, 'add')).toMatch(/Usage/)
})

test('the wake-up limit is set by a variable', async ($, on) => {
  fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CROSSTALK_WAKE_LIMIT: '3' })
  await $.session.start(START)
  expect(await say($, '')).toMatch(/of 3\./)
})

// Opening a session in a new terminal.
const unlink = (d: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(d.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))))
test('a profile starts with its saved command, else its shortcut', async () => {
  expect(launchFor('zai', { launch: { zai: ' claude zai ' } })).toBe('claude zai')
  expect(launchFor('work', {})).toBe('claude-work')
  expect(launchFor('default', undefined)).toBe('claude')
})

test('only Claude Code is started', async () => {
  for (const ok of ['claude', 'claude zai', 'claude-work', 'claude-work --resume', 'claude zai --model glm-5.3']) expect(isSafeLaunch(ok)).toBe(true)
  for (const bad of ['rm -rf x', 'claude; calc', 'claude && x', 'claude $(x)', 'claude `x`', 'claude | x', 'claudex', ' claude', 'claude\nx']) expect(isSafeLaunch(bad)).toBe(false)
})

test('open can set the model and permission mode, and nothing that breaks the launch rule', async () => {
  expect(withLaunchFlags('claude zai', {})).toEqual({ command: 'claude zai' })
  expect(withLaunchFlags('claude-mikey', { model: 'sonnet', permissionMode: 'plan' })).toEqual({ command: 'claude-mikey --model sonnet --permission-mode plan' })
  expect(withLaunchFlags('claude', { model: ' claude-sonnet-5-5 ' })).toEqual({ command: 'claude --model claude-sonnet-5-5' })
  expect(withLaunchFlags('claude', { permissionMode: 'acceptEdits' })).toEqual({ command: 'claude --permission-mode acceptEdits' })
  for (const model of ['opus[1m]', 'x;y', 'a b', '$(x)']) expect(withLaunchFlags('claude', { model }).error).toMatch(/can't be a model/)
  for (const permissionMode of ['bypassPermissions', 'plan; calc', 'yolo']) expect(withLaunchFlags('claude', { permissionMode }).error).toMatch(/isn't a permission mode/)
  for (const opts of [{ model: 'glm-5.3', permissionMode: 'dontAsk' }, { model: 'opus', permissionMode: 'auto' }]) expect(isSafeLaunch(withLaunchFlags('claude-work', opts).command)).toBe(true)
})

test('a permission mode is matched whatever its case', async () => {
  expect(withLaunchFlags('claude', { permissionMode: 'acceptedits' })).toEqual({ command: 'claude --permission-mode acceptEdits' })
  expect(withLaunchFlags('claude', { permissionMode: 'PLAN' })).toEqual({ command: 'claude --permission-mode plan' })
  expect(withLaunchFlags('claude', { permissionMode: 'BypassPermissions' }).error).toMatch(/isn't a permission mode/)
})

test('/crosstalk open reads --model and --mode after the profile, and the rest is the message', async () => {
  expect(parseOpenArgs(['Mikey', '--model', 'sonnet', '--mode=plan', 'say', 'hi'])).toEqual({ profile: 'mikey', model: 'sonnet', permissionMode: 'plan', message: 'say hi' })
  expect(parseOpenArgs(['zai', '--permission-mode', 'auto'])).toEqual({ profile: 'zai', model: '', permissionMode: 'auto', message: '' })
  expect(parseOpenArgs(['zai', 'use', '--model', 'x'])).toEqual({ profile: 'zai', model: '', permissionMode: '', message: 'use --model x' })
  expect(parseOpenArgs(['zai', '--fast']).error).toMatch(/Unknown option --fast/)
  expect(parseOpenArgs(['zai', '--model']).error).toMatch(/needs a value/)
  expect(parseOpenArgs(['zai', '--mode=']).error).toMatch(/needs a value/)
  expect(parseOpenArgs([])).toEqual({ profile: '', model: '', permissionMode: '', message: '' })
})

test('on macOS a Terminal window opens in the folder, however the folder is named', async () => {
  expect(shQuote("it's here")).toBe("'it'\\''s here'")
  const argv = macArgv('/Users/me/a "b" \\c', 'claude-mikey --model sonnet')
  expect(argv.slice(0, 2)).toEqual(['osascript', '-e'])
  expect(argv[2]).toBe('tell application "Terminal" to do script "cd \'/Users/me/a \\"b\\" \\\\c\' && claude-mikey --model sonnet"')
  expect(argv.slice(3)).toEqual(['-e', 'tell application "Terminal" to activate'])
})

test('on Linux the terminal is tmux when inside it, else the first desktop one, and a chosen one first', async () => {
  expect(linuxCandidates({ inTmux: true, hasDisplay: false })).toEqual(['tmux'])
  expect(linuxCandidates({ inTmux: false, hasDisplay: false })).toEqual([])
  expect(linuxCandidates({ inTmux: false, hasDisplay: true })[0]).toBe('gnome-terminal')
  expect(linuxCandidates({ wanted: 'Kitty', inTmux: true, hasDisplay: true }).slice(0, 2)).toEqual(['kitty', 'tmux'])
  expect(linuxCandidates({ wanted: 'rm', inTmux: false, hasDisplay: true })).not.toContain('rm')
  expect(whichArgv(['tmux', 'xterm']).slice(-2)).toEqual(['tmux', 'xterm'])
  expect(userShell('/usr/bin/zsh')).toBe('/usr/bin/zsh')
  for (const bad of [undefined, '', 'zsh', '/bin/sh; rm', '/bin/$(x)']) expect(userShell(bad)).toBe('/bin/bash')
  const run = ['/bin/zsh', '-ic', "cd '/home/me/my proj' && claude-mikey; exec /bin/zsh"]
  expect(linuxArgv('tmux', '/home/me/my proj', 'claude-mikey', '/bin/zsh')).toEqual(['tmux', 'new-window', '-c', '/home/me/my proj', ...run])
  expect(linuxArgv('gnome-terminal', '/home/me/my proj', 'claude-mikey', '/bin/zsh')).toEqual(['gnome-terminal', '--', ...run])
  expect(linuxArgv('kitty', '/home/me/my proj', 'claude-mikey', '/bin/zsh')).toEqual(['sh', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'sh', 'kitty', ...run])
  expect(linuxArgv('xterm', '/home/me/my proj', 'claude-mikey', '/bin/zsh').slice(4)).toEqual(['xterm', '-e', ...run])
})

test('a folder is marked trusted in a profile record, and nothing else changes', async () => {
  const added = JSON.parse(trustProject('', 'C:\\code\\proj')!)
  expect(added).toEqual({ projects: { 'C:/code/proj': { hasTrustDialogAccepted: true } } })
  const before = { numStartups: 3, projects: { 'C:/other': { allowedTools: ['x'] }, 'C:/code/proj': { history: [1], hasTrustDialogAccepted: false } } }
  const after = JSON.parse(trustProject(JSON.stringify(before), 'C:\\code\\proj\\')!)
  expect(after).toEqual({ numStartups: 3, projects: { 'C:/other': { allowedTools: ['x'] }, 'C:/code/proj': { history: [1], hasTrustDialogAccepted: true } } })
  expect(trustProject(JSON.stringify(after), 'C:/code/proj')).toBe(null)
  expect(JSON.parse(trustProject('{}', 'C:\\')!).projects).toEqual({ 'C:/': { hasTrustDialogAccepted: true } })
  for (const bad of ['{"projects":', '[1]', 'null', '{"projects":[]}']) expect(trustProject(bad, 'C:\\code\\proj')).toBe(null)
})

test('where a session opens: the variable, then the setting, then VS Code if this runs there', async () => {
  expect(chooseOpenIn(undefined, undefined, 'vscode', true)).toEqual({ where: 'vscode' })
  expect(chooseOpenIn(undefined, undefined, 'vscode', false).where).toBe('window')
  expect(chooseOpenIn(undefined, undefined, 'vscode', false).why).toMatch(/helper/)
  expect(chooseOpenIn(undefined, undefined, 'WindowsTerminal', true)).toEqual({ where: 'window', why: '' })
  expect(chooseOpenIn('window', 'vscode', 'vscode', true)).toEqual({ where: 'window' })
  expect(chooseOpenIn(undefined, 'vscode', '', true)).toEqual({ where: 'vscode' })
  expect(chooseOpenIn('nonsense', 'window', 'vscode', true)).toEqual({ where: 'window' })
})

test('the VS Code link carries any folder whole', async () => {
  const cwd = 'C:\\Users\\me\\Local Sites\\a & b'
  const link = vscodeLink({ name: 'claude zai', cwd, cmd: 'claude zai' })
  expect(link).toMatch(/^vscode:\/\/svumo\.crosstalk-terminal\/open\?d=[A-Za-z0-9_-]+$/)
  const d = link.split('d=')[1]
  expect(unlink(d)).toEqual({ name: 'claude zai', cwd, cmd: 'claude zai' })
  expect(windowArgv(cwd, 'claude zai')).toEqual(['wt', '-w', 'new', '-d', cwd, 'pwsh', '-NoExit', '-Command', 'claude zai'])
})

test('the session that opened is the new one of that profile in this folder', async () => {
  const r = (id: string, profile: string, cwd: string, startedAt: number) => ({ id, profile, address: `${profile}/${id}`, cwd, startedAt, seenAt: NOW })
  const records = [r('old', 'zai', 'C:\\code\\proj', NOW - 99_000), r('else', 'zai', 'C:\\other', NOW), r('w', 'work', 'C:\\code\\proj', NOW), r('new', 'zai', 'c:/code/proj/', NOW)]
  expect(findOpened(records, 'zai', 'C:\\code\\proj', NOW - 5_000, NOW)?.id).toBe('new')
  expect(findOpened(records, 'glm', 'C:\\code\\proj', NOW - 5_000, NOW)).toBe(null)
})

test('open runs the VS Code link, then hands the new session its first message', async ($, on) => {
  const calls: any[] = []
  const files: any = fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', TERM_PROGRAM: 'vscode' }, (e: any, disk: Map<string, string>) => {
    calls.push(e.argv)
    if (e.argv.includes('--list-extensions')) return { ...RAN_OK, stdout: 'aaron-bond.better-comments\r\nsvumo.crosstalk-terminal\r\n' }
    if (e.argv.includes('--open-url')) disk.set(`${BOX}/sessions/zai-1.json`, JSON.stringify({ id: 'zai-1', profile: 'zai', address: 'zai/proj-zai1', cwd: 'C:\\code\\proj', startedAt: NOW, seenAt: NOW }))
    return RAN_OK
  })
  on('clock.sleep', () => ({ value: undefined }))
  seed(files, 'C:/home/.claude-zai', { '.claude.json': JSON.stringify({ numStartups: 2, projects: { 'C:/elsewhere': { hasTrustDialogAccepted: true } } }) })
  await $.session.start(START)
  expect(await say($, 'launch zai claude zai')).toMatch(/zai starts with: claude zai/)
  expect(await say($, 'launch zai rm -rf x')).toMatch(/only starts Claude Code/)
  const text = await say($, 'open zai say hello')
  expect(text).toMatch(/Opening zai \(claude zai\) in a new VS Code terminal/)
  expect(text).not.toMatch(/trust/)
  expect(JSON.parse(files.get('C:/home/.claude-zai/.claude.json'))).toEqual({ numStartups: 2, projects: { 'C:/elsewhere': { hasTrustDialogAccepted: true }, 'C:/code/proj': { hasTrustDialogAccepted: true } } })
  const open = calls.find((a) => a.includes('--open-url'))!
  const d = open[open.length - 1].split('d=')[1]
  expect(unlink(d)).toEqual({ name: 'claude zai', cwd: 'C:\\code\\proj', cmd: 'claude zai' })
  await settle()
  const sent = [...files.keys()].find((k: string) => k.startsWith(`${BOX}/inbox/zai-1/`))!
  expect(JSON.parse(files.get(sent)).text).toBe('say hello')
  expect(files.logs.some((l: string) => /zai\/proj-zai1 is up and has your message/.test(l))).toBe(true)
})

test('VSCodium is told apart from VS Code, and the variable wins', () => {
  const codium = 'C:\\Program Files\\VSCodium\\VSCodium.exe'
  expect(editorFor(undefined, undefined, codium)).toEqual({ cli: 'codium', scheme: 'vscodium', label: 'VSCodium', how: 'spotted' })
  expect(editorFor(undefined, undefined, 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe').cli).toBe('code')
  expect(editorFor(undefined, undefined, undefined).cli).toBe('code')
  expect(editorFor('codium', undefined, undefined)).toMatchObject({ cli: 'codium', how: 'CLAUDE_CROSSTALK_EDITOR' })
  expect(editorFor('code', 'codium', codium)).toMatchObject({ cli: 'code', how: 'CLAUDE_CROSSTALK_EDITOR' })
  expect(editorFor(undefined, 'code', codium)).toMatchObject({ cli: 'code', how: 'saved' })
  expect(editorFor('nonsense', 'auto', codium)).toMatchObject({ cli: 'codium', how: 'spotted' })
  expect(chooseOpenIn(undefined, undefined, 'vscode', false, 'VSCodium').why).toBe("the Crosstalk terminal helper isn't installed in VSCodium")
  expect(helperInstall(EDITORS.codium, 'C:\\plug\\crosstalk\\1.4.1\\')).toBe('codium --install-extension "C:\\plug\\crosstalk\\1.4.1/vscode/crosstalk-terminal-0.3.0.vsix"')
  expect(vscodeLink({ name: 'a', cwd: 'b', cmd: 'claude' }, 'vscodium')).toMatch(/^vscodium:\/\/svumo\.crosstalk-terminal\/open\?d=/)
})

test('open in VSCodium uses codium and its own link', async ($, on) => {
  const calls: any[] = []
  fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: 'C:\\Program Files\\VSCodium\\VSCodium.exe' }, (e: any) => {
    calls.push(e.argv)
    if (e.argv.includes('--list-extensions')) return { ...RAN_OK, stdout: 'svumo.crosstalk-terminal\n' }
    return RAN_OK
  })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  expect(await say($, 'open zai')).toMatch(/in a new VSCodium terminal/)
  expect(calls.find((a) => a.includes('--list-extensions'))![0]).toBe('codium')
  const open = calls.find((a) => a.includes('--open-url'))!
  expect(open[0]).toBe('codium')
  expect(open[open.length - 1]).toMatch(/^vscodium:\/\//)
  expect(calls.some((a) => a[0] === 'code')).toBe(false)
})

test('open-in alone says what open will do from here, and editor changes it', async ($, on) => {
  let listed = 'svumo.crosstalk-terminal\n'
  const calls: any[] = []
  fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: 'C:\\Program Files\\VSCodium\\VSCodium.exe' }, (e: any) => {
    calls.push(e.argv)
    if (e.argv.includes('--list-extensions')) return { ...RAN_OK, stdout: listed }
    return RAN_OK
  })
  await $.session.start(START)
  let text = await say($, 'open-in')
  expect(text).toMatch(/open starts a VSCodium terminal tab/)
  expect(text).toMatch(/Editor: VSCodium \(spotted from this session's terminal\)\. Helper: installed/)
  listed = 'aaron-bond.better-comments\n'
  text = await say($, 'open-in')
  expect(text).toMatch(/open starts a new terminal window/)
  expect(text).toMatch(/helper isn't installed in VSCodium/)
  expect(text).toMatch(/Install the helper: codium --install-extension ".*crosstalk-terminal-0\.3\.0\.vsix"/)
  expect(await say($, 'editor sideways')).toMatch(/Usage: \/crosstalk editor auto\|code\|codium/)
  expect(await say($, 'editor vscode')).toMatch(/Editor: code\./)
  expect(await say($, 'editor')).toMatch(/Editor: code\. Choices/)
  listed = 'svumo.crosstalk-terminal\n'
  expect(await say($, 'open-in')).toMatch(/Editor: VS Code \(set by \/crosstalk editor\)/)
  expect(calls[calls.length - 1][0]).toBe('code')
  expect(await say($, 'editor auto')).toMatch(/Editor: auto\./)
  expect(await say($, 'open-in')).toMatch(/Editor: VSCodium \(spotted/)
})

test('open-in window opens a terminal window, and the setting is kept', async ($, on) => {
  const calls: any[] = []
  fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', TERM_PROGRAM: 'vscode' }, (e: any) => { calls.push(e.argv); return RAN_OK })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  expect(await say($, 'open-in sideways')).toMatch(/Usage/)
  expect(await say($, 'open-in window')).toMatch(/open in: window/)
  const status = await say($, 'open-in')
  expect(status).toMatch(/open in: window/)
  expect(status).toMatch(/Helper: not checked, as open-in is window/)
  expect(status).not.toMatch(/Install the helper/)
  const opened = await say($, 'open zai')
  expect(opened).toMatch(/new terminal window/)
  expect(opened).toMatch(/may stop at the folder-trust screen/) // no zai profile to mark
  expect(calls.some((a) => a.includes('--list-extensions'))).toBe(false)
  expect(calls.find((a) => a[0] === 'wt')).toEqual(['wt', '-w', 'new', '-d', 'C:\\code\\proj', 'pwsh', '-NoExit', '-Command', 'claude-zai'])
})

test('the open tool passes the model and permission mode on, and refuses bypassPermissions', async ($, on) => {
  const calls: any[] = []
  const files: any = fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', CLAUDE_CROSSTALK_OPEN_IN: 'window' }, (e: any) => { calls.push(e.argv); return RAN_OK })
  on('clock.sleep', () => ({ value: undefined }))
  seed(files, 'C:/home/.claude', { '.claude.json': '{}' })
  files.set('C:/home/.claude.json', '{"projects":{"C:/code/proj":{"hasTrustDialogAccepted":true}}}')
  await $.session.start(START)
  const refused: any = await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'default', permissionMode: 'bypassPermissions' } as never)
  expect(JSON.stringify(refused)).toMatch(/isn't a permission mode/)
  expect(calls.some((a) => a[0] === 'wt')).toBe(false)
  const ok: any = await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'default', model: 'sonnet', permissionMode: 'plan' } as never)
  expect(JSON.stringify(ok)).toMatch(/Opening default \(claude --model sonnet --permission-mode plan\)/)
  expect(JSON.stringify(ok)).not.toMatch(/trust/)
  expect(calls.find((a) => a[0] === 'wt')!.at(-1)).toBe('claude --model sonnet --permission-mode plan')
  expect(JSON.parse(files.get('C:/home/.claude/.claude.json')).projects['C:/code/proj'].hasTrustDialogAccepted).toBe(true)
  expect(files.get('C:/home/.claude.json')).toBe('{"projects":{"C:/code/proj":{"hasTrustDialogAccepted":true}}}') // already trusted: left as it was
})

test('/crosstalk open takes --model and --mode, and says what is wrong with a bad one', async ($, on) => {
  const calls: any[] = []
  fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', CLAUDE_CROSSTALK_OPEN_IN: 'window' }, (e: any) => { calls.push(e.argv); return RAN_OK })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  expect(await say($, 'open zai --fast hi')).toMatch(/Unknown option --fast/)
  expect(await say($, 'open zai --mode bypassPermissions hi')).toMatch(/isn't a permission mode/)
  expect(calls.some((a) => a[0] === 'wt')).toBe(false)
  expect(await say($, 'open zai --model opus --mode acceptedits review it')).toMatch(/Opening zai \(claude-zai --model opus --permission-mode acceptEdits\)/)
  expect(calls.find((a) => a[0] === 'wt')!.at(-1)).toBe('claude-zai --model opus --permission-mode acceptEdits')
})

test('a trust mark written over by a running session is put back', async ($, on) => {
  const files: any = fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', CLAUDE_CROSSTALK_OPEN_IN: 'window' })
  const record = 'C:/home/.claude-zai/.claude.json'
  const original = JSON.stringify({ numStartups: 5 })
  let clobbers = 1
  let always = false
  on('clock.sleep', () => { if (always || clobbers-- > 0) files.set(record, original); return { value: undefined } })
  seed(files, 'C:/home/.claude-zai', { '.claude.json': original })
  await $.session.start(START)
  expect(await say($, 'open zai')).not.toMatch(/trust/)
  expect(JSON.parse(files.get(record))).toEqual({ numStartups: 5, projects: { 'C:/code/proj': { hasTrustDialogAccepted: true } } })
  always = true
  files.set(record, original)
  expect(await say($, 'open zai')).toMatch(/may stop at the folder-trust screen/)
})

const UNIX_ENV = { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/home/me/.claude-work', SHELL: '/bin/zsh', CLAUDE_CROSSTALK_OPEN_IN: 'window' }

test('on macOS open starts a Terminal window', async ($, on) => {
  const calls: any[] = []
  let refused = false
  fakeDisk(on, UNIX_ENV, (e: any) => {
    calls.push(e)
    if (e.argv[0] === 'uname') return { ...RAN_OK, stdout: 'Darwin\n' }
    if (e.argv[0] === 'osascript' && refused) return { ...RAN_OK, exitCode: 1, stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)' }
    return RAN_OK
  })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  expect(await say($, 'open mikey --mode plan')).toMatch(/Opening mikey \(claude-mikey --permission-mode plan\) in a new Terminal window/)
  const osascript = calls.find((c) => c.argv[0] === 'osascript')
  expect(osascript.argv).toEqual(macArgv('C:\\code\\proj', 'claude-mikey --permission-mode plan'))
  expect(osascript.init?.timeoutMs ?? osascript.timeoutMs).toBe(120_000) // time to answer macOS's first-time prompt
  refused = true
  expect(await say($, 'open mikey')).toMatch(/Privacy & Security > Automation/)
})

test('on Linux open uses the terminal it finds, and says so when there is none', async ($, on) => {
  const calls: any[] = []
  let installed = 'konsole\n'
  fakeDisk(on, { ...UNIX_ENV, DISPLAY: ':0' }, (e: any) => {
    calls.push(e.argv)
    if (e.argv[0] === 'uname') return { ...RAN_OK, stdout: 'Linux\n' }
    if (e.argv[0] === 'sh' && e.argv[2].startsWith('for t')) return installed ? { ...RAN_OK, stdout: installed } : { ...RAN_OK, exitCode: 1 }
    return RAN_OK
  })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  expect(await say($, 'open mikey')).toMatch(/in a new konsole window/)
  expect(calls.at(-1)).toEqual(linuxArgv('konsole', 'C:\\code\\proj', 'claude-mikey', '/bin/zsh'))
  installed = ''
  expect(await say($, 'open mikey')).toMatch(/Couldn't find a terminal to open/)
})

// Session titles: the name the person sees in the desktop app, or from /rename.

test('a title is one tidy line, and a session is named by it with its address', async () => {
  expect(cleanTitle('  Claude Fuuk\nfor   next task\u0007 ')).toBe('Claude Fuuk for next task')
  expect(cleanTitle(undefined)).toBe('')
  expect(cleanTitle('x'.repeat(300)).length).toBe(120)
  expect(labelOf({ address: 'default/a-1', title: 'Fix the login' })).toBe('Fix the login (default/a-1)')
  expect(labelOf({ address: 'default/a-1', title: '  ' })).toBe('default/a-1')
  expect(listLine({ address: 'default/a-1', title: 'Fix the login', cwd: 'C:\\code' })).toBe('Fix the login (default/a-1, folder C:\\code)')
  expect(listLine({ address: 'default/a-1', cwd: 'C:\\code' })).toBe('default/a-1 (folder C:\\code)')
})

test('the desktop app title is read from its session file, only for this session', async () => {
  const file = (o: object) => JSON.stringify({ sessionId: 'local_1', cliSessionId: 'cli-1', title: 'Claude Fuuk for next task', titleSource: 'auto', ...o })
  expect(appTitle(file({}), 'cli-1')).toBe('Claude Fuuk for next task')
  expect(appTitle(file({ cliSessionId: 'cli-2', lastAssistantCliSessionId: 'cli-1' }), 'cli-1')).toBe('Claude Fuuk for next task')
  expect(appTitle(file({}), 'someone-else')).toBe('') // a terminal that inherited the app's variables
  expect(appTitle(file({ title: 42 }), 'cli-1')).toBe('')
  expect(appTitle('{not json', 'cli-1')).toBe('')
})

test('a transcript title: /rename wins over the made one, the last of each counts, a cut line is skipped', async () => {
  const row = (o: object) => JSON.stringify(o)
  const ai = (t: string) => row({ type: 'ai-title', aiTitle: t, sessionId: 's' })
  const custom = (t: string) => row({ type: 'custom-title', customTitle: t, sessionId: 's' })
  expect(transcriptTitle([ai('First go'), row({ type: 'user', message: 'x' }), ai('Better name')].join('\n'))).toBe('Better name')
  expect(transcriptTitle([custom('Mine'), ai('Made one')].join('\n'))).toBe('Mine')
  expect(transcriptTitle(['tle","aiTitle":"cut off"}', ai('Whole')].join('\n'))).toBe('Whole')
  expect(transcriptTitle('')).toBe('')
})

test('a transcript is found under the folder the CLI names after the working folder', async () => {
  expect(projectFolderName('C:\\Users\\me\\Documents\\github\\claude-crosstalk\\.claude\\worktrees\\zen-1')).toBe('C--Users-me-Documents-github-claude-crosstalk--claude-worktrees-zen-1')
  expect(projectFolderName('/home/me/my app')).toBe('-home-me-my-app')
})

test('the app data folder: the one its Claude Code runs from, a second copy for this profile, then the usual ones', async () => {
  const msix = 'C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude'
  const found = appDataFolders({
    execPath: `${msix}\\claude-code\\2.1.317\\a33aa\\claude.exe`,
    appData: 'C:\\Users\\me\\AppData\\Roaming', localAppData: 'C:\\Users\\me\\AppData\\Local', home: 'C:\\Users\\me', profile: 'fuuk',
  })
  expect(found.slice(0, 3)).toEqual([msix.replace(/\\/g, '/'), 'C:/Users/me/.claude-fuuk-app', 'C:/Users/me/AppData/Roaming/Claude'])
  expect(found.filter((f) => f.toLowerCase() === msix.replace(/\\/g, '/').toLowerCase()).length).toBe(1) // once, though listed twice
  const second = appDataFolders({ execPath: 'C:\\Users\\me\\.claude-fuuk-app\\claude-code\\2.1.317\\x\\claude.exe', home: 'C:\\Users\\me', profile: 'fuuk' })
  expect(second[0]).toBe('C:/Users/me/.claude-fuuk-app')
  expect(appDataFolders({ override: 'D:\\apps\\claude\\', home: '/home/me', profile: 'default' })).toEqual(['D:/apps/claude', '/home/me/Library/Application Support/Claude', '/home/me/.config/Claude'])
})

test('a message can go to a session by its title, when only one has it', async () => {
  const t = (id: string, address: string, title: string) => ({ ...rec(id, address.split('/')[0], address), title })
  const all = [rec('me', 'work', 'work/a-1'), t('f1', 'fuuk/x-1', 'Claude Fuuk for next task'), t('d1', 'default/y-2', 'Same name'), t('d2', 'default/z-3', 'Same name')]
  expect(resolveTarget('claude fuuk for next task', all, 'me', NOW).record?.id).toBe('f1')
  expect(resolveTarget('"Claude Fuuk for next task"', all, 'me', NOW).record?.id).toBe('f1')
  expect(resolveTarget('Same name', all, 'me', NOW).error).toMatch(/could be several sessions: Same name \(default\/y-2\), Same name \(default\/z-3\)/)
  expect(resolveTarget('nobody', all, 'me', NOW).error).toMatch(/Running now: Claude Fuuk for next task \(fuuk\/x-1\)/)
  expect(resolveTarget('fuuk', all, 'me', NOW).record?.id).toBe('f1') // a profile still works
})

const APP = 'C:/home/.claude-work-app'
const APP_ENV = {
  USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work',
  CLAUDE_CODE_HOST_SESSION_ID: 'local_abc-1', CLAUDE_CODE_EXECPATH: 'C:\\home\\.claude-work-app\\claude-code\\2.1.0\\abc\\claude.exe',
  CLAUDE_CODE_ACCOUNT_UUID: 'acct', CLAUDE_CODE_ORGANIZATION_UUID: 'org',
}
const appFile = (title: string, cli = 'self-1') => JSON.stringify({ sessionId: 'local_abc-1', cliSessionId: cli, title })
const TRANSCRIPT = 'C:/home/.claude-work/projects/C--code-proj/self-1.jsonl'

test('a desktop-app session goes by its app title, read from its own app copy, and follows a rename', async ($, on) => {
  const files = fakeDisk(on, APP_ENV)
  files.set(`${APP}/claude-code-sessions/acct/org/local_abc-1.json`, appFile('New session'))
  await $.session.start(START)
  const mine = () => JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!)
  expect(mine().title).toBe('New session')
  expect(mine().address).toBe('work/proj-self') // the address stays

  files.set(`${APP}/claude-code-sessions/acct/org/local_abc-1.json`, appFile('Claude Fuuk for next task'))
  files.beat()
  await settle()
  expect(mine().title).toBe('Claude Fuuk for next task')

  files.set(`${BOX}/sessions/other.json`, JSON.stringify({ id: 'other', profile: 'personal', address: 'personal/x-oth', cwd: 'C:/y', seenAt: NOW, title: 'Tidy the docs' }))
  const listed: any = await $.tool.call({ tool: 'mcp__crosstalk__list' } as never)
  expect(JSON.stringify(listed)).toMatch(/You are Claude Fuuk for next task \(work\/proj-self\)/)
  expect(JSON.stringify(listed)).toMatch(/Tidy the docs \(personal\/x-oth, folder C:\/y\)/)

  const sent: any = await $.tool.call({ tool: 'mcp__crosstalk__send', to: 'tidy the docs', text: 'hi' } as never)
  expect(JSON.stringify(sent)).toMatch(/Sent to Tidy the docs \(personal\/x-oth\)/)
  const written = [...files.keys()].find((k) => k.startsWith(`${BOX}/inbox/other/`))!
  expect(JSON.parse(files.get(written)!)).toMatchObject({ from: 'work/proj-self', fromTitle: 'Claude Fuuk for next task' })
})

test('without the account variables the app file is looked for in each account folder', async ($, on) => {
  const { CLAUDE_CODE_ACCOUNT_UUID: _a, CLAUDE_CODE_ORGANIZATION_UUID: _o, ...env } = APP_ENV
  const files = fakeDisk(on, env)
  files.set(`${APP}/claude-code-sessions/other-acct/other-org/local_zzz-9.json`, appFile('Not mine'))
  files.set(`${APP}/claude-code-sessions/acct2/org2/local_abc-1.json`, appFile('Found it'))
  await $.session.start(START)
  expect(JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!).title).toBe('Found it')
})

test('a terminal session goes by its transcript title, and so does one whose app variables are not its own', async ($, on) => {
  const files = fakeDisk(on, APP_ENV)
  files.set(`${APP}/claude-code-sessions/acct/org/local_abc-1.json`, appFile('The parent session', 'parent-cli'))
  files.set(TRANSCRIPT, `${JSON.stringify({ type: 'ai-title', aiTitle: 'Review the PR' })}\n`)
  await $.session.start(START)
  expect(JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!).title).toBe('Review the PR')
})

test('a session with no title yet goes by its address, and is named when one comes', async ($, on) => {
  const files = fakeDisk(on)
  await $.session.start(START)
  expect(JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!).title).toBe('')
  const said: any = await $.command.run({ command: 'crosstalk', args: '' } as never)
  expect(JSON.stringify(said)).toMatch(/You are work\/proj-self\./)
  files.set(TRANSCRIPT, `${JSON.stringify({ type: 'custom-title', customTitle: 'Renamed by hand' })}\n`)
  files.beat()
  await settle()
  expect(JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!).title).toBe('Renamed by hand')
})

test('a message from a titled session shows the title with the address', async () => {
  const m = { from: 'fuuk/x-1', fromTitle: 'Claude Fuuk for next task', sentAt: NOW, text: 'done', name: 'a.json' }
  expect(frameMessages([m])).toMatch(/From Claude Fuuk for next task \(fuuk\/x-1\), sent/)
  expect(showMessages([m])).toMatch(/^Crosstalk ← Claude Fuuk for next task \(fuuk\/x-1\) · /)
})
