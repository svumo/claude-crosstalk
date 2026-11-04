import { expect, test } from 'claude-code/testing'

import {
  addressOf, frameMessages, isLive, LIVE_MS, mayWake, messageFileName,
  pendingNames, profileName, resolveTarget, toolResultCount, toolUseCount,
} from '../hooks/core.mjs'

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
const slash = (path: string) => path.replace(/\\/g, '/')

function fakeDisk(on: any, env: Record<string, string> = { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work' }) {
  const files = new Map<string, string>()
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
    const names = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((n) => !n.includes('/'))
    return { value: names.map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
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
