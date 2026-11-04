import { expect, test } from 'claude-code/testing'

import {
  addressOf, frameMessages, isLive, LIVE_MS, mayWake, messageFileName,
  pendingNames, profileName, resolveTarget, SHOW_TEXT, showMessages, toolResultCount, toolUseCount,
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

// The mod itself, with a folder in memory standing for the disk. The host hands paths over in Windows spelling.
const slash = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/home\/me)/, '') // and may add a drive to a Unix path

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
  on('process.run', (_: any, e: any) => ({ value: run(e, files) }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  files.logs = [] as string[]
  on('ui.log', (_: any, e: any) => { files.logs.push(e.text); return { value: undefined } })
  on('clock.now', () => ({ value: NOW }))
  // Polling runs when a test says so; everything else never ticks.
  on('clock.every', (_: any, e: any) => new Promise<any>((resolve) => { if (e.ms === 3000) (files as any).tick = () => resolve({ value: undefined }) }))
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
