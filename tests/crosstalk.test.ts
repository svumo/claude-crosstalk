import { expect, test } from 'claude-code/testing'

import {
  addressOf, frameMessages, isLive, LIVE_MS, mayWake, messageFileName,
  pendingNames, profileName, resolveTarget, SHOW_TEXT, showMessages, toolResultCount, toolUseCount,
  chooseOpenIn, editorFor, EDITORS, helperInstall, findOpened, isSafeLaunch, launchFor, trustProject, vscodeLink, windowArgv, withLaunchFlags,
  linuxArgv, linuxCandidates, macArgv, parseOpenArgs, shQuote, userShell, whichArgv,
  appDataFolders, appPanelCommand, appTitle, cleanTitle, labelOf, listLine, projectFolderName, transcriptTitle,
  chosenProfile, choiceLabel, flagApplies, flagEnds, FLAG_MS, handoffName, isPaused, moveChoices, NOT_NOW, parsePercent, pausedNote,
  resumePrompt, stopPoint, summaryOf, usagePhrase, worstWindow,
  appWindowOf, chooseOpenProfile, hostWindow, parseParents, windowNote, profileWord,
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

test('an address goes by the session title once it has one, else its folder', async () => {
  expect(addressOf('default', 'C:\\scratch\\scratch-2026-11-09-641b34', '3071f301', 'Claude code mod fix')).toBe('default/claude-code-mod-fix-3071')
  expect(addressOf('work', 'C:\\code\\proj', 'ab12', '  ')).toBe('work/proj-ab12')
  expect(addressOf('work', 'C:\\code\\proj', 'ab12', '✨ !!')).toBe('work/proj-ab12')
  // cut at 32 characters, with no dash left hanging at the cut
  expect(addressOf('work', 'x', 'ab12', 'Build listing ingest + value model for the shop')).toBe('work/build-listing-ingest-value-model-ab12')
  expect(addressOf('work', 'x', 'ab12', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b')).toBe('work/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-ab12')
})

test('a session is still reached at the folder address it had before its title came', async () => {
  const titled = { ...rec('p1', 'personal', 'personal/fix-the-login-b-2'), alias: 'personal/b-2' }
  const all = [rec('me', 'work', 'work/a-1'), titled]
  expect(resolveTarget('personal/fix-the-login-b-2', all, 'me', NOW).record?.id).toBe('p1')
  expect(resolveTarget('personal/b-2', all, 'me', NOW).record?.id).toBe('p1')
  expect(resolveTarget('b-2', all, 'me', NOW).record?.id).toBe('p1')
  expect(resolveTarget('fix-the-login-b-2', all, 'me', NOW).record?.id).toBe('p1')
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
  on('session.cwd', () => ({ value: env.TEST_CWD ?? 'C:\\code\\proj' }))
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
  expect(parseOpenArgs(['Mikey', '--model', 'sonnet', '--mode=plan', 'say', 'hi'])).toEqual({ profile: 'mikey', model: 'sonnet', permissionMode: 'plan', openIn: '', message: 'say hi' })
  expect(parseOpenArgs(['zai', '--permission-mode', 'auto'])).toEqual({ profile: 'zai', model: '', permissionMode: 'auto', openIn: '', message: '' })
  expect(parseOpenArgs(['zai', 'use', '--model', 'x'])).toEqual({ profile: 'zai', model: '', permissionMode: '', openIn: '', message: 'use --model x' })
  expect(parseOpenArgs(['zai', '--fast']).error).toMatch(/Unknown option --fast/)
  expect(parseOpenArgs(['zai', '--model']).error).toMatch(/needs a value/)
  expect(parseOpenArgs(['zai', '--mode=']).error).toMatch(/needs a value/)
  expect(parseOpenArgs([])).toEqual({ profile: '', model: '', permissionMode: '', openIn: '', message: '' })
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

test('in the desktop app, auto and app open a tab of its Terminal panel', async () => {
  expect(chooseOpenIn(undefined, undefined, '', false, 'VS Code', true)).toEqual({ where: 'app' })
  expect(chooseOpenIn(undefined, 'app', '', false, 'VS Code', true)).toEqual({ where: 'app' })
  expect(chooseOpenIn('app', 'window', '', false, 'VS Code', true)).toEqual({ where: 'app' })
  expect(chooseOpenIn(undefined, 'window', '', false, 'VS Code', true)).toEqual({ where: 'window' })
  expect(chooseOpenIn(undefined, 'vscode', '', true, 'VS Code', true)).toEqual({ where: 'vscode' })
  expect(chooseOpenIn(undefined, 'app', 'vscode', true)).toEqual({ where: 'window', why: "this session isn't running in the Claude desktop app" })
  expect(chooseOpenIn(undefined, undefined, 'vscode', true)).toEqual({ where: 'vscode' }) // not in the app: as before
})

test("a folder at the desktop app's packaged spelling is the same folder", async () => {
  const plain = 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch\\s1'
  const packaged = 'C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\scratch\\s1'
  const r = { id: 'm', profile: 'mikey', address: 'mikey/s1-m', cwd: packaged, startedAt: NOW, seenAt: NOW }
  expect(findOpened([r], 'mikey', plain, NOW - 5_000, NOW)?.id).toBe('m')
  expect(findOpened([r], 'mikey', 'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch\\s2', NOW - 5_000, NOW)).toBe(null)
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

test('from the desktop app, open types the launch command into a new Terminal panel tab', async ($, on) => {
  const calls: any[] = []
  const typed: any[] = []
  let refuse = ''
  const files: any = fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, (e: any) => { calls.push(e.argv); return RAN_OK })
  on('tool.call', { tool: 'mcp__terminal__run_in_terminal' }, (_: any, e: any) => {
    typed.push(e)
    return refuse ? { deny: refuse } : { result: [{ type: 'text', text: 'Started in new terminal tab "c1"' }] }
  })
  on('clock.sleep', () => ({ value: undefined }))
  files.set(`${BOX}/setup.json`, JSON.stringify({ launch: { mikey: 'claude mikey' } }))
  await $.session.start(START)
  await say($, 'open-in panel')
  const status = await say($, 'open-in')
  expect(status).toMatch(/new tab in the Claude desktop app's Terminal panel/)
  const ok: any = await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'mikey', model: 'sonnet' } as never)
  expect(JSON.stringify(ok)).toMatch(/Opening mikey \(claude mikey --model sonnet\) in a new tab of the app's Terminal panel/)
  expect(typed.at(-1)).toMatchObject({ command: "$env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; claude mikey --model sonnet", cwd: 'C:\\code\\proj', title: 'claude mikey' })
  expect(calls.some((a) => a[0] === 'wt' || a.includes('--list-extensions'))).toBe(false) // no window, no editor check
  refuse = 'The user declined'
  expect(await say($, 'open mikey hi')).toMatch(/Terminal panel didn't run it: The user declined\. \/crosstalk open-in window/)
  expect(await say($, 'open-in window')).toMatch(/open in: window/)
  expect(await say($, 'open mikey')).toMatch(/new terminal window/)
  expect(typed.length).toBe(2)
})

test('open-in app outside the desktop app opens a window, and says why', async ($, on) => {
  const calls: any[] = []
  fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', CLAUDE_CROSSTALK_OPEN_IN: 'app' }, (e: any) => { calls.push(e.argv); return RAN_OK })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  expect(await say($, 'open-in')).toMatch(/Why a window: this session isn't running in the Claude desktop app/)
  expect(await say($, 'open zai')).toMatch(/new terminal window, as this session isn't running in the Claude desktop app/)
  expect(calls.some((a) => a[0] === 'wt')).toBe(true)
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
  // the address follows the title, and the folder one is kept as its alias
  expect(mine().address).toBe('work/new-session-self')
  expect(mine().alias).toBe('work/proj-self')

  files.set(`${APP}/claude-code-sessions/acct/org/local_abc-1.json`, appFile('Claude Fuuk for next task'))
  files.beat()
  await settle()
  expect(mine().title).toBe('Claude Fuuk for next task')
  expect(mine().address).toBe('work/claude-fuuk-for-next-task-self')

  files.set(`${BOX}/sessions/other.json`, JSON.stringify({ id: 'other', profile: 'personal', address: 'personal/x-oth', cwd: 'C:/y', seenAt: NOW, title: 'Tidy the docs' }))
  const listed: any = await $.tool.call({ tool: 'mcp__crosstalk__list' } as never)
  expect(JSON.stringify(listed)).toMatch(/You are Claude Fuuk for next task \(work\/claude-fuuk-for-next-task-self\)/)
  expect(JSON.stringify(listed)).toMatch(/Tidy the docs \(personal\/x-oth, folder C:\/y\)/)

  const sent: any = await $.tool.call({ tool: 'mcp__crosstalk__send', to: 'tidy the docs', text: 'hi' } as never)
  expect(JSON.stringify(sent)).toMatch(/Sent to Tidy the docs \(personal\/x-oth\)/)
  const written = [...files.keys()].find((k) => k.startsWith(`${BOX}/inbox/other/`))!
  expect(JSON.parse(files.get(written)!)).toMatchObject({ from: 'work/claude-fuuk-for-next-task-self', fromTitle: 'Claude Fuuk for next task' })
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

test('a Terminal panel tab keeps its transcript: the app marker is overridden, in the shell the tab runs', async () => {
  expect(appPanelCommand('claude mikey', true)).toBe("$env:CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1'; claude mikey")
  expect(appPanelCommand('claude-work --model opus', false)).toBe('export CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1; claude-work --model opus')
})

// ---- Usage guard ----

test('the fullest window counts, and none off a subscription', async () => {
  expect(worstWindow([{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 93.5 }])?.kind).toBe('seven_day')
  expect(worstWindow([])).toBe(null)
  expect(worstWindow(undefined)).toBe(null)
})

test("a stop point: this session's own first, then a large context's, then the account's", async () => {
  const large = { stop: 85, context: 60 }
  expect(stopPoint({ account: 93, here: 0, large, contextPercent: 30 })).toEqual({ percent: 93, why: 'account' })
  expect(stopPoint({ account: 93, here: 0, large, contextPercent: 60 })).toEqual({ percent: 85, why: 'large' })
  expect(stopPoint({ account: 93, here: 80, large, contextPercent: 70 })).toEqual({ percent: 80, why: 'here' })
  expect(stopPoint({ account: 80, here: 0, large, contextPercent: 70 })).toEqual({ percent: 80, why: 'account' }) // never later than the account
  expect(stopPoint({ account: 93, here: 0, large: null, contextPercent: 99 })).toEqual({ percent: 93, why: 'account' })
  expect(stopPoint({ account: 0, here: 0, large: null, contextPercent: 10 })).toEqual({ percent: 0, why: 'off' })
  expect(parsePercent('85%')).toBe(85)
  expect(parsePercent('off')).toBe(0)
  expect(parsePercent('0')).toBe(null)
  expect(parsePercent('101')).toBe(null)
})

test('a flag stops sessions on its profile or account, until its window resets', async () => {
  const flag = { profile: 'work', account: 'acct-1', kind: 'five_hour', percent: 93, resetsAt: new Date(NOW + 1000).toISOString(), at: NOW }
  expect(flagApplies(flag, { profile: 'work' }, NOW)).toBe(true)
  expect(flagApplies(flag, { profile: 'renamed', account: 'acct-1' }, NOW)).toBe(true)
  expect(flagApplies(flag, { profile: 'mikey', account: 'acct-2' }, NOW)).toBe(false)
  expect(flagApplies(flag, { profile: 'work' }, NOW + 1000)).toBe(false)
  expect(flagEnds({ at: NOW })).toBe(NOW + FLAG_MS)
})

test('the move picker: other profiles, lowest usage first, tripped ones and this one left out', async () => {
  const r = (id: string, profile: string, percent?: number) => ({ ...rec(id, profile, `${profile}/x-${id}`), usage: percent === undefined ? undefined : { percent } })
  const records = [r('a', 'work', 95), r('b', 'mikey', 40), r('c', 'mikey', 12), r('d', 'zai', 5), r('e', 'fuuk')]
  const flags = [{ profile: 'zai', at: NOW }]
  const choices = moveChoices(records, ['glm', 'mikey'], { profile: 'work' }, flags, NOW)
  expect(choices).toEqual([{ profile: 'mikey', percent: 40 }, { profile: 'fuuk', percent: null }, { profile: 'glm', percent: null }])
  expect(choiceLabel(choices[0])).toBe('mikey (40%)')
  expect(choiceLabel(choices[1])).toBe('fuuk (no reading)')
  expect(chosenProfile('mikey (40%)', choices)).toBe('mikey')
  expect(chosenProfile('Personal', choices)).toBe('personal') // typed under Other
  expect(chosenProfile(NOT_NOW, choices)).toBe('')
})

test('the summary is the first message after a compaction, and nothing when it was skipped', async () => {
  expect(summaryOf({ messages: [{ role: 'user', text: ' the plan ', toolUses: [] }] })).toBe('the plan')
  expect(summaryOf({ skip: 'vetoed' })).toBe('')
  expect(handoffName(Date.UTC(2026, 10, 9, 15, 31), 'work/fix-the-login-ab12')).toBe('2026-11-09-1531-work-fix-the-login-ab12.md')
})

test('a moved session works alone when the origin stopped near its limit, else reports back when done', async () => {
  const me = { address: 'work/fix-ab12', profile: 'work', cwd: 'C:\\code\\proj' }
  const alone = resumePrompt('C:/h/x.md', me, true)
  expect(alone).toMatch(/^Resume from a handoff: read C:\/h\/x\.md first/)
  expect(alone).toMatch(/You own this work alone: don't message work\/fix-ab12/)
  expect(alone).toMatch(/ask the user in your own chat/)
  expect(alone).not.toMatch(/only if you're blocked or when done/)
  const healthy = resumePrompt('C:/h/x.md', me, false)
  expect(healthy).toMatch(/Message work\/fix-ab12 over crosstalk only if you're blocked or when done\./)
  expect(healthy).not.toMatch(/alone/)
})

test('a session is paused when its guard holds it or its window is past its stop point', async () => {
  expect(isPaused({ usage: { percent: 94, stopAt: 93 } })).toBe(true)
  expect(isPaused({ usage: { percent: 50, stopAt: 93, isHeld: true } })).toBe(true)
  expect(isPaused({ usage: { percent: 50, stopAt: 93 } })).toBe(false)
  expect(isPaused({ usage: { percent: 99, stopAt: 0 } })).toBe(false) // guard off
  expect(isPaused({})).toBe(false)
  expect(usagePhrase({ kind: 'five_hour', percent: 94, stopAt: 93 })).toBe('at 94% of its 5-hour limit, over its stop point (93%)')
  expect(usagePhrase({ kind: 'seven_day', percent: 20, stopAt: 93 })).toBe('at 20% of its weekly limit, stops at 93%')
  expect(usagePhrase(undefined)).toBe('')
  expect(pausedNote({ ...rec('o', 'work', 'work/o-1'), usage: { kind: 'five_hour', percent: 95, stopAt: 93 } })).toMatch(/paused near its usage limit .*ask the user in your own chat/)
})

// The engine side: a fake disk, a compaction, a question and a terminal, as the person would see them.
const RESET = '2026-11-09T20:00:00.000Z'
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) await settle()
  return check()
}
const measure = ($: any, percentUsed: number, contextPercent = 30) =>
  $.session.measure({ context: { window: 200_000, percent: contextPercent }, rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: RESET }], changed: ['rateLimits'] })

function guardWorld(on: any, answer = 'mikey (12%)') {
  const ran: any[] = []
  const files: any = fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work' }, (e: any) => { ran.push(e.argv); return RAN_OK })
  const w: any = { files, ran, aborted: [] as string[], compacted: [] as any[], asked: [] as any[] }
  on('clock.sleep', () => ({ value: undefined }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.abort', (_: any, e: any) => { w.aborted.push(e.turnId); return { value: undefined } })
  on('session.compact', (_: any, e: any) => { w.compacted.push(e); return { messages: [{ role: 'user', text: 'SUMMARY: fix the login, tests left', toolUses: [] }] } })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    w.asked.push(e)
    const q = e.questions?.[0]?.question
    return { result: { questions: e.questions, answers: { [q]: answer } } }
  })
  files.set(`${BOX}/setup.json`, JSON.stringify({ launch: { mikey: 'claude mikey' } }))
  // mikey is running at 12%, and a mikey session in this folder shows up once opened.
  files.set(`${BOX}/sessions/m1.json`, JSON.stringify({ id: 'm1', profile: 'mikey', address: 'mikey/x-m1', cwd: 'C:\\elsewhere', seenAt: NOW, startedAt: 1, usage: { kind: 'five_hour', percent: 12, stopAt: 93 } }))
  w.openedNew = () => files.set(`${BOX}/sessions/new-1.json`, JSON.stringify({ id: 'new-1', profile: 'mikey', address: 'mikey/proj-new', cwd: 'C:\\code\\proj', seenAt: NOW, startedAt: NOW }))
  w.handoff = () => [...files.keys()].find((k: string) => k.startsWith(`${BOX}/handoffs/`))
  w.resume = () => {
    const k = [...files.keys()].find((x: string) => x.startsWith(`${BOX}/inbox/new-1/`))
    return k ? JSON.parse(files.get(k)).text : ''
  }
  return w
}

test('at 93% a session flags its account, stops its turn, compacts, writes a handoff, asks, and opens the pick', async ($, on) => {
  const w = guardWorld(on)
  await $.session.start(START)
  w.openedNew()
  await $.turn.start({ turnId: 't1' } as never)
  await measure($, 93)
  expect(await until(() => w.resume() !== '')).toBe(true)
  const flag = JSON.parse(w.files.get(`${BOX}/usage/work.json`))
  expect(flag).toMatchObject({ profile: 'work', kind: 'five_hour', percent: 93, resetsAt: RESET, by: 'work/proj-self' })
  expect(w.aborted).toEqual(['t1'])
  expect(w.compacted[0].instructions).toMatch(/handoff/)
  const handoff = w.files.get(w.handoff())
  expect(handoff).toMatch(/93% of its 5-hour limit/)
  expect(handoff).toMatch(/SUMMARY: fix the login/)
  expect(handoff).toMatch(/projects\/C--code-proj\/self-1\.jsonl/)
  expect(JSON.stringify(w.asked[0])).toMatch(/work is at 93% of its 5-hour limit\. Move this session to another account\?/)
  expect(JSON.stringify(w.asked[0])).toMatch(/mikey \(12%\).*Not now/)
  expect(w.ran.some((argv: string[]) => argv.join(' ').includes('claude mikey'))).toBe(true)
  expect(w.resume()).toMatch(/You own this work alone: don't message work\/proj-self/)
  expect(w.files.logs.some((l: string) => /stopped and compacted\. Handoff: [^\n]*\n\nSUMMARY/.test(l))).toBe(true)
  expect(isPaused(JSON.parse(w.files.get(`${BOX}/sessions/self-1.json`)))).toBe(true)
})

test('another session on the same profile stops from the flag alone; Not now leaves it here, held', async ($, on) => {
  const w = guardWorld(on, NOT_NOW)
  const submitted: string[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text, origin: e.origin } })
  w.files.set(`${BOX}/usage/work.json`, JSON.stringify({ profile: 'work', kind: 'five_hour', percent: 94, resetsAt: RESET, at: NOW, by: 'work/other-1' }))
  await $.session.start(START)
  w.files.set(`${BOX}/inbox/self-1/${messageFileName(NOW, 'a')}`, JSON.stringify({ from: 'zai/x-oth', sentAt: NOW, text: 'wake up' }))
  w.files.tick()
  expect(await until(() => w.files.logs.some((l: string) => /left here/.test(l)))).toBe(true)
  expect(w.compacted.length).toBe(1)
  expect(w.files.get(w.handoff())).toMatch(/94% of its 5-hour limit/)
  expect(submitted.length).toBe(0) // the message waits: no wake-ups while held
  expect(w.ran.some((argv: string[]) => argv.join(' ').includes('claude mikey'))).toBe(false)
})

test('a flag for another profile leaves this session alone', async ($, on) => {
  const w = guardWorld(on)
  w.files.set(`${BOX}/usage/mikey.json`, JSON.stringify({ profile: 'mikey', kind: 'five_hour', percent: 95, resetsAt: RESET, at: NOW }))
  await $.session.start(START)
  w.files.tick()
  await settle()
  await settle()
  expect(w.compacted.length).toBe(0)
  expect(w.handoff()).toBe(undefined)
})

test('a session set to stop early stops alone, flags nothing, and keeps the point in its record', async ($, on) => {
  const w = guardWorld(on, NOT_NOW)
  await $.session.start(START)
  expect(await say($, 'usage here 80')).toMatch(/stops at 80%/)
  await measure($, 79)
  await settle()
  expect(w.compacted.length).toBe(0)
  await measure($, 80)
  expect(await until(() => w.compacted.length === 1)).toBe(true)
  expect(w.files.has(`${BOX}/usage/work.json`)).toBe(false)
  expect(JSON.parse(w.files.get(`${BOX}/sessions/self-1.json`)).guard.here).toBe(80)
})

test('a large context stops at 85% by default, and usage large changes it', async ($, on) => {
  const w = guardWorld(on, NOT_NOW)
  await $.session.start(START)
  await measure($, 84, 72)
  await settle()
  expect(w.compacted.length).toBe(0)
  expect(await say($, 'usage')).toMatch(/This session stops at 85%, as its context is 72% full\./)
  await measure($, 85, 72)
  expect(await until(() => w.compacted.length === 1)).toBe(true)
  expect(w.files.has(`${BOX}/usage/work.json`)).toBe(false)
  expect(await say($, 'usage large 75 50')).toMatch(/50% full or more stops at 75%/)
  expect(JSON.parse(w.files.get(`${BOX}/setup.json`)).usageLarge).toEqual({ stop: 75, context: 50 })
})

test('usage sets the account point, and off turns the guard off', async ($, on) => {
  const w = guardWorld(on)
  await $.session.start(START)
  expect(await say($, 'usage 90')).toMatch(/stops at 90%/)
  expect(JSON.parse(w.files.get(`${BOX}/setup.json`)).usageStop).toBe(90)
  expect(await say($, 'usage off')).toMatch(/guard is off/)
  await measure($, 99)
  await settle()
  expect(w.compacted.length).toBe(0)
  expect(await say($, 'usage nonsense')).toMatch(/^Usage:/)
})

test('move hands a healthy session over at once, and the new one reports back only when blocked or done', async ($, on) => {
  const w = guardWorld(on)
  await $.session.start(START)
  w.openedNew()
  await measure($, 20)
  expect(await say($, 'move mikey')).toMatch(/Moving this session to mikey/)
  expect(await until(() => w.resume() !== '')).toBe(true)
  expect(w.asked.length).toBe(0)
  expect(w.compacted.length).toBe(1)
  expect(w.resume()).toMatch(/Message work\/proj-self over crosstalk only if you're blocked or when done\./)
  expect(await say($, 'move work')).toMatch(/already on work/)
})

test('sending to a session paused for usage still delivers, and says it will not answer yet', async ($, on) => {
  const w = guardWorld(on)
  await $.session.start(START)
  w.files.set(`${BOX}/sessions/p1.json`, JSON.stringify({ id: 'p1', profile: 'fuuk', address: 'fuuk/x-p1', cwd: 'y', seenAt: NOW, usage: { kind: 'five_hour', percent: 95, resetsAt: RESET, stopAt: 93, isHeld: true } }))
  const sent: any = await $.tool.call({ tool: 'mcp__crosstalk__send', to: 'fuuk', text: 'done' } as never)
  expect(JSON.stringify(sent)).toMatch(/Sent to fuuk\/x-p1\. fuuk\/x-p1 is paused near its usage limit/)
  expect([...w.files.keys()].some((k: string) => k.startsWith(`${BOX}/inbox/p1/`))).toBe(true)
  const listed: any = await $.tool.call({ tool: 'mcp__crosstalk__list' } as never)
  expect(JSON.stringify(listed)).toMatch(/fuuk\/x-p1[^"]*\(paused near its usage limit\)/)
})

// Which app window a session runs in, and which profile `open` picks from it.
const STORE = 'C:\\Program Files\\WindowsApps\\Claude_4.23118.0.0_x64__pzs8sxrjxfjjc\\app\\claude.exe'
// A mikey session in a Terminal-panel tab of the fuuk window, as the parent walk prints it.
const IN_FUUK = [
  'C:\\WINDOWS\\System32\\cmd.exe\tcmd.exe /d /s /c "pwsh"',
  'C:\\Users\\me\\.local\\bin\\claude.exe\t"C:\\Users\\me\\.local\\bin\\claude.exe" mikey',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe\t"pwsh.exe" -NoProfile -NoExit -Command x',
  `${STORE.replace('claude.exe', 'Claude.exe')}\t"${STORE}" --type=utility --utility-sub-type=node.mojom.NodeService`,
  `${STORE}\t"${STORE}" --user-data-dir="C:\\Users\\me\\.claude-fuuk-app" "claude://code/new?folder=C%3A%5Cx"`,
  'C:\\WINDOWS\\explorer.exe\tC:\\WINDOWS\\Explorer.EXE',
].join('\r\n')

test('an app window is told from its process: the main window, a profile window, and what is not one', async () => {
  expect(appWindowOf(STORE, `"${STORE}"`)).toBe('default')
  expect(appWindowOf(STORE, `"${STORE}" --user-data-dir="C:\\Users\\me\\.claude-fuuk-app" "claude://x"`)).toBe('fuuk')
  expect(appWindowOf(STORE, `${STORE} --user-data-dir=C:\\Users\\me\\.claude-Work-app`)).toBe('work')
  expect(appWindowOf('C:\\Users\\me\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe', 'claude.exe')).toBe('default')
  expect(appWindowOf(STORE, `"${STORE}" --type=renderer --user-data-dir="C:\\Users\\me\\.claude-fuuk-app"`)).toBe('')
  expect(appWindowOf('C:\\Users\\me\\.local\\bin\\claude.exe', 'claude.exe')).toBe('') // the CLI
  expect(appWindowOf('C:\\Users\\me\\.claude-fuuk-app\\claude-code\\2.1\\claude.exe', 'claude.exe')).toBe('') // the app's copy for sessions
})

test('a session is in the nearest app window above it, and in none outside the app', async () => {
  expect(parseParents(IN_FUUK)).toHaveLength(6)
  expect(hostWindow(parseParents(IN_FUUK))).toBe('fuuk')
  expect(hostWindow(parseParents(IN_FUUK.split('\r\n').slice(0, 3).join('\n')))).toBe('')
  expect(hostWindow([])).toBe('')
  expect(windowNote({ window: 'fuuk' })).toBe(', in the fuuk app window')
  expect(windowNote({})).toBe('')
  expect(listLine({ address: 'mikey/x-1', cwd: 'C:\\p', window: 'fuuk' })).toBe('mikey/x-1 (folder C:\\p, in the fuuk app window)')
})

test('open with no profile stays on this session\'s own, a named one wins, and "window" uses the window\'s', async () => {
  expect(chooseOpenProfile('', 'fuuk', 'fuuk')).toEqual({ profile: 'fuuk', why: "this session's own profile, as none was named", note: '' })
  expect(chooseOpenProfile(undefined, 'mikey', '').profile).toBe('mikey')
  expect(chooseOpenProfile(' Here ', 'mikey', '').profile).toBe('mikey')
  const tab = chooseOpenProfile('', 'mikey', 'fuuk')
  expect(tab.profile).toBe('mikey')
  expect(tab.note).toMatch(/tab of the fuuk app window: open fuuk \(or "window"\)/)
  expect(chooseOpenProfile('Default', 'mikey', 'fuuk')).toEqual({ profile: 'default', why: '', note: '' })
  expect(chooseOpenProfile('window', 'mikey', 'fuuk').profile).toBe('fuuk')
  expect(chooseOpenProfile('window', 'mikey', '').error).toMatch(/can't tell which Claude app window/)
  expect(parseOpenArgs(['--model', 'sonnet', 'hi'])).toEqual({ profile: '', model: 'sonnet', permissionMode: '', openIn: '', message: 'hi' })
})

test('from a tab of another account\'s window, open picks this session\'s profile unless one is named', async ($, on) => {
  const typed: any[] = []
  const walks: any[] = []
  const files: any = fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-mikey', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, (e: any) => {
    if (e.argv[0] === 'powershell.exe') { walks.push(e.argv); return { ...RAN_OK, stdout: IN_FUUK } }
    return RAN_OK
  })
  on('tool.call', { tool: 'mcp__terminal__run_in_terminal' }, (_: any, e: any) => { typed.push(e); return { result: [{ type: 'text', text: 'Started' }] } })
  on('clock.sleep', () => ({ value: undefined }))
  files.set(`${BOX}/setup.json`, JSON.stringify({ launch: { mikey: 'claude mikey', fuuk: 'claude fuuk' } }))
  await $.session.start(START)
  await say($, 'open-in panel')
  const listed: any = await $.tool.call({ tool: 'mcp__crosstalk__list' } as never)
  expect(JSON.stringify(listed)).toMatch(/You are mikey\/proj-self, in the fuuk app window\./)
  expect(walks).toHaveLength(1)
  expect(walks[0].at(-1)).not.toMatch(/"/) // no double quotes to survive Windows quoting
  const unnamed: any = await $.tool.call({ tool: 'mcp__crosstalk__open', message: 'hi' } as never)
  expect(JSON.stringify(unnamed)).toMatch(/Opening mikey \(claude mikey\) in a new tab of the fuuk app window's Terminal panel\. mikey is this session's own profile, as none was named\. This session runs in a tab of the fuuk app window/)
  expect(typed.at(-1).command).toMatch(/; claude mikey$/)
  const named: any = await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'fuuk' } as never)
  expect(JSON.stringify(named)).toMatch(/Opening fuuk \(claude fuuk\)/)
  expect(JSON.stringify(named)).not.toMatch(/none was named/)
  expect(await say($, 'open window')).toMatch(/Opening fuuk \(claude fuuk\).*fuuk is the account of the fuuk app window this session runs in/)
  expect(typed.map((t) => t.command.split('; ').at(-1))).toEqual(['claude mikey', 'claude fuuk', 'claude fuuk'])
  expect(JSON.parse(files.get(`${BOX}/sessions/self-1.json`)!).window).toBe('fuuk')
})

test('outside the app no process walk runs, and "window" says it can\'t tell', async ($, on) => {
  const calls: any[] = []
  fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', CLAUDE_CROSSTALK_OPEN_IN: 'window' }, (e: any) => { calls.push(e.argv); return RAN_OK })
  on('clock.sleep', () => ({ value: undefined }))
  await $.session.start(START)
  expect(await say($, 'open window')).toMatch(/can't tell which Claude app window/)
  expect(await say($, 'open')).toMatch(/Opening work \(claude-work\) in a new terminal window\. work is this session's own profile/)
  expect(calls.some((a) => a[0] === 'powershell.exe')).toBe(false)
})

// ---- Open where you are, shorter commands, notifications that open their own window ----

test('a profile is told as people say it, and open takes --in', async () => {
  expect(['fuuk', 'claude-fuuk', 'claude fuuk', 'the fuuk app', 'my Work account', 'claude', 'main'].map(profileWord))
    .toEqual(['fuuk', 'fuuk', 'fuuk', 'fuuk', 'work', 'default', 'default'])
  expect(parseOpenArgs(['claude', 'fuuk', '--in', 'window', 'hi'])).toMatchObject({ profile: 'claude-fuuk', openIn: 'window', message: 'hi' })
  expect(parseOpenArgs(['fuuk', '--in', 'nowhere']).error).toMatch(/--in takes/)
  expect(chooseOpenIn('panel', undefined, '', false, 'VS Code', true)).toEqual({ where: 'panel' })
  expect(chooseOpenIn('editor', undefined, 'vscode', true)).toEqual({ where: 'vscode' })
})

// A mikey session in the app, with fuuk's app window on disk and the plugin's scripts in place.
function inAppWindows(on: any, extraEnv: Record<string, string> = {}, hasHost = false) {
  const calls: any[] = []
  const typed: any[] = []
  const files: any = fakeDisk(on, { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-mikey', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ...extraEnv }, (e: any) => {
    calls.push(e.argv)
    if (e.argv[0] === 'powershell.exe' && e.argv.includes('-Command')) return { ...RAN_OK, stdout: IN_FUUK }
    return RAN_OK
  })
  if (hasHost) files.set(`${BOX}/app-windows/ToastHost.exe`, '')
  on('tool.call', { tool: 'mcp__terminal__run_in_terminal' }, (_: any, e: any) => { typed.push(e); return { result: [{ type: 'text', text: 'Started' }] } })
  on('clock.sleep', () => ({ value: undefined }))
  files.set('C:/home/.claude-fuuk-app/Preferences', '{}')
  files.set(`${BOX}/setup.json`, JSON.stringify({ launch: { mikey: 'claude mikey', fuuk: 'claude fuuk' } }))
  return { calls, typed, files }
}

test('from the app on Windows, open starts the session in the named profile\'s own app window', async ($, on) => {
  const { calls, typed, files } = inAppWindows(on)
  await $.session.start(START)
  const opened: any = await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'claude fuuk', message: 'review the diff' } as never)
  expect(JSON.stringify(opened)).toMatch(/Opened fuuk in fuuk's Claude app window\. Its first message was sent/)
  const run = calls.find((a) => a.includes('-File') && /claude-new-session\.ps1$/.test(a[a.indexOf('-File') + 1]))!
  expect(run.slice(run.indexOf('-File') + 2, run.indexOf('-File') + 4)).toEqual(['fuuk', 'C:\\code\\proj'])
  expect(run).toContain('-Send')
  const promptFile = run[run.indexOf('-PromptFile') + 1]
  expect(files.get(slash(promptFile))).toMatch(/^\[Crosstalk\] .*opened this session\. It says:\n\nreview the diff$/)
  expect(typed).toHaveLength(0) // not the Terminal panel
  expect(calls.some((a) => a[0] === 'wt')).toBe(false) // not a window of the terminal
  // The main window needs no folder of its own; with no message nothing is sent.
  const main: any = await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'default' } as never)
  expect(JSON.stringify(main)).toMatch(/Opened default in the main Claude app window\..*nothing was sent/)
  expect(calls.filter((a) => a.includes('-Send'))).toHaveLength(1)
})

test('a spare session opens in its project folder, from the app file, not its temporary one', async ($, on) => {
  const SPARE = 'C:\\home\\.claude-work\\spares\\spare-AbC123'
  const calls: any[] = []
  const files: any = fakeDisk(on, { ...APP_ENV, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', TEST_CWD: SPARE }, (e: any) => { calls.push(e.argv); return RAN_OK })
  on('clock.sleep', () => ({ value: undefined }))
  files.set('C:/home/.claude-fuuk-app/Preferences', '{}')
  const appPath = `${APP}/claude-code-sessions/acct/org/local_abc-1.json`
  files.set(appPath, JSON.stringify({ sessionId: 'local_abc-1', cliSessionId: 'self-1', title: 'Spare', cwd: 'C:\\code\\real', originCwd: 'C:\\code\\real' }))
  await $.session.start({ ...START, cwd: SPARE })
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'fuuk', message: 'hi' } as never))).toMatch(/Opened fuuk in fuuk's Claude app window/)
  const run = calls.find((a) => a.some((x: string) => /claude-new-session\.ps1$/.test(x)))!
  expect(run[run.indexOf('fuuk') + 1]).toBe('C:\\code\\real')
  // Without a project folder on record, it says so instead of handing the app a folder that is gone.
  files.set(appPath, JSON.stringify({ sessionId: 'local_abc-1', cliSessionId: 'self-1', title: 'Spare', cwd: SPARE }))
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__crosstalk__open', profile: 'fuuk', message: 'hi' } as never))).toMatch(/temporary folder the app made/)
})

test('a profile with no app window yet is said, not guessed at, and --in panel still works', async ($, on) => {
  const { typed } = inAppWindows(on)
  await $.session.start(START)
  const missing = await say($, 'open zai hello')
  expect(missing).toMatch(/zai has no Claude app window on this computer yet.*--in panel/)
  expect(await say($, 'open zai --in panel hello')).toMatch(/Opening zai \(claude-zai\) in a new tab of the .*Terminal panel/)
  expect(typed).toHaveLength(1)
})

test('a profile\'s name works as a command, and to sends without the model', async ($, on) => {
  const { calls, files } = inAppWindows(on)
  await $.session.start(START)
  files.set(`${BOX}/sessions/other.json`, JSON.stringify({ id: 'other', profile: 'fuuk', address: 'fuuk/x-oth', cwd: 'y', seenAt: NOW }))
  expect(await say($, 'fuuk look at the build')).toMatch(/Opened fuuk in fuuk's Claude app window/)
  expect(calls.some((a) => a.includes('-PromptFile'))).toBe(true)
  expect(await say($, 'to fuuk check the build')).toMatch(/^Sent to fuuk\/x-oth/)
  expect([...files.keys()].some((k: string) => k.startsWith(`${BOX}/inbox/other/`))).toBe(true)
  expect(await say($, 'to')).toMatch(/^Usage: \/crosstalk to/)
  expect(await say($, 'help')).toMatch(/\/crosstalk where/)
  expect(await say($, '')).toMatch(/\/crosstalk <profile> \[message\]/)
})

test('a session in an account window raises a notification that opens that window, once the helper is built', async ($, on) => {
  const { calls } = inAppWindows(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_abc-123' }, true)
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start(START)
  await settle()
  await $.turn.start({ turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done' } as never)
  await settle()
  const toast = calls.find((a) => a.includes('-File') && /claude-toast\.ps1$/.test(a[a.indexOf('-File') + 1]))!
  expect(toast.slice(toast.indexOf('-File') + 2, toast.indexOf('-File') + 4)).toEqual(['fuuk', 'local_abc-123'])
  expect(toast.at(-1)).toBe('fuuk: finished')
  expect(toast[toast.indexOf('-File') + 1]).toBe(`C:/home/.claude-crosstalk/app-windows/claude-toast.ps1`) // the built copy, not the plugin's
})

test('no notification until the helper is built', async ($, on) => {
  const first = inAppWindows(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_abc-123' })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start(START)
  await settle()
  await $.turn.start({ turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done' } as never)
  await settle()
  expect(first.calls.some((a) => a.some((x: string) => /claude-toast\.ps1$/.test(x)))).toBe(false)
})
