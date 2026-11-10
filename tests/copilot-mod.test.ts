import { expect, test } from 'claude-code/testing'

import { parseCopilot, pickTask, statusLine } from '../copilot/mod/args.ts'
import type { TaskStateFile } from '../copilot/protocol/layout.ts'
import { permissionText, personOnly } from '../copilot/protocol/render.ts'
import { emptyUsage, makeEnvelope, parseEnvelope } from '../copilot/protocol/schema.ts'
import type { PermissionRequestBody } from '../copilot/protocol/schema.ts'

const NOW = 1_000_000
const BOX = 'C:/home/.claude-crosstalk'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const START = { cwd: 'C:\\code\\proj', surface: 'terminal', isInteractive: true } as const
const RAN_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const slash = (path: string) => path.replace(/\\/g, '/')
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const say = async ($: any, args: string, origin: any = { kind: 'composer' }) => (await $.command.run({ command: 'copilot', args, origin })).text as string

// What git and node answer on this pretend computer. `git` maps the words after `-C <cwd>` to output.
function computer(on: any, git: Record<string, string> = {}, node = 'v22.18.0') {
  const files: any = new Map<string, string>()
  const calls: string[][] = []
  const answers: Record<string, string> = {
    'rev-parse': 'C:/code/proj\nC:/code/proj/.git\n',
    status: `# branch.oid ${SHA}\n# branch.head main\n1 .M N... 100644 100644 100644 a b src/login.ts\n`,
    worktree: `worktree C:/code/proj\nHEAD ${SHA}\nbranch refs/heads/main\n`,
    remote: 'https://github.com/me/proj.git\n',
    ...git,
  }
  const env: Record<string, string> = { USERPROFILE: 'C:\\home', CLAUDE_CONFIG_DIR: 'C:\\home\\.claude-work', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', OS: 'Windows_NT' }
  on('env.get', (_: any, e: any) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'self-1' }))
  on('session.cwd', () => ({ value: 'C:\\code\\proj' }))
  on('session.model', () => ({ value: 'fable' }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__crosstalk__${e.name}` } }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('fs.write', (_: any, e: any) => { files.set(slash(e.path), e.text); return { value: undefined } })
  on('fs.read', (_: any, e: any) => {
    if (!files.has(slash(e.path))) throw new Error('ENOENT')
    return { value: files.get(slash(e.path)) }
  })
  on('fs.list', (_: any, e: any) => {
    const prefix = `${slash(e.path)}/`
    const rests = [...files.keys()].filter((k: string) => k.startsWith(prefix)).map((k: string) => k.slice(prefix.length))
    if (rests.length === 0) throw new Error('ENOENT')
    const names = [...new Set(rests.map((r: string) => r.split('/')[0]))]
    return { value: names.map((name) => ({ name, kind: rests.includes(name) ? 'file' : 'dir', size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.exists', (_: any, e: any) => ({ value: files.has(slash(e.path)) }))
  on('fs.stat', (_: any, e: any) => {
    if (!files.has(slash(e.path))) throw new Error('ENOENT')
    return { value: { kind: 'file', size: files.get(slash(e.path)).length, mtimeMs: 1, isLink: false } }
  })
  on('process.run', (_: any, e: any) => {
    calls.push(e.argv)
    if (e.argv[0] === 'node' && e.argv[1] === '--version') return { value: node === '' ? { ...RAN_OK, exitCode: 1 } : { ...RAN_OK, stdout: `${node}\n` } }
    if (e.argv[0] === 'git') {
      const answer = answers[e.argv[3]]
      return { value: answer === undefined || answer === 'FAIL' ? { ...RAN_OK, exitCode: 128 } : { ...RAN_OK, stdout: answer } }
    }
    return { value: RAN_OK }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  files.toasts = [] as string[]
  files.logs = [] as string[]
  on('ui.toast', (_: any, e: any) => { files.toasts.push(e.text); return { value: undefined } })
  on('ui.log', (_: any, e: any) => { files.logs.push(e.text); return { value: undefined } })
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', (_: any, e: any) => new Promise<any>((resolve) => {
    if (e.ms === 3000) files.tick = () => resolve({ value: undefined })
  }))
  files.set('C:/code/proj/AGENTS.md', 'rules')
  return { files, calls }
}

const stateOf = (over: Partial<TaskStateFile>): TaskStateFile => ({
  task_id: 'fix-login-x9q2', state: 'awaiting_approval', detail: 'r1', task: 'Fix login', origin_id: 'self-1', origin_address: 'work/proj-self',
  branch: 'copilot/fix-login-x9q2', worktree: 'C:/code/proj-copilot/fix-login-x9q2', backend: 'acp', model: '', usage: { ...emptyUsage(), prompts: 1 },
  pending: ['r1'], started_at: NOW - 120_000, updated_at: NOW, pid: 1, ...over,
})
const putState = (files: any, state: TaskStateFile) => files.set(`${BOX}/copilot/tasks/${state.task_id}/state.json`, JSON.stringify(state))

test('what follows /copilot is a command only in its exact shape, else a task in the person\'s words', async () => {
  expect(parseCopilot('')).toEqual({ verb: 'help' })
  expect(parseCopilot('status')).toEqual({ verb: 'status' })
  expect(parseCopilot('setup')).toEqual({ verb: 'setup' })
  expect(parseCopilot('setup the database migrations')).toEqual({ verb: 'task', task: 'setup the database migrations' })
  expect(parseCopilot('approve r3')).toEqual({ verb: 'decide', decision: 'approve', requestId: 'r3', taskId: '' })
  expect(parseCopilot('allow r3 fix-login-x9q2')).toEqual({ verb: 'decide', decision: 'allow_task', requestId: 'r3', taskId: 'fix-login-x9q2' })
  expect(parseCopilot('deny r12')).toEqual({ verb: 'decide', decision: 'deny', requestId: 'r12', taskId: '' })
  expect(parseCopilot('stop')).toEqual({ verb: 'stop', taskId: '' })
  expect(parseCopilot('stop fix-login-x9q2')).toEqual({ verb: 'stop', taskId: 'fix-login-x9q2' })
  expect(parseCopilot('stop the flaky test from failing')).toEqual({ verb: 'task', task: 'stop the flaky test from failing' })
  expect(parseCopilot('approve the design doc and tidy it')).toEqual({ verb: 'task', task: 'approve the design doc and tidy it' })
  expect(parseCopilot('status of the build is red, fix it')).toEqual({ verb: 'task', task: 'status of the build is red, fix it' })
})

test('a status line says how a task stands and what waits on the person', async () => {
  expect(statusLine(stateOf({}), NOW)).toBe('fix-login-x9q2: awaiting approval, started 2 min ago, 1 prompt, 0.0 AI credits (0 in, 0 cached, 0 out). Waiting for you: /copilot approve r1.')
  const two = [stateOf({}), stateOf({ task_id: 'other-aaaa' })]
  expect(pickTask(two, '', (s) => s.pending.includes('r1'), 'is waiting on r1').error).toMatch(/More than one task is waiting on r1: fix-login-x9q2, other-aaaa/)
  expect(pickTask(two, 'other-aaaa', () => true, 'x').state?.task_id).toBe('other-aaaa')
  expect(pickTask(two, '', () => false, 'is running').error).toMatch(/No task of this session is running/)
})

test('/copilot <task> captures the session, writes the handoff and starts the sidecar', async ($, on) => {
  const { files, calls } = computer(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\code\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' } as never).catch(() => {})
  const text = await say($, 'Fix the login page')
  const started = calls.find((a) => a[0] === 'node' && a[2] === 'start')!
  expect(slash(started[1])).toMatch(/\/copilot\/sidecar\/main\.ts$/)
  expect(started.slice(4)).toEqual(['--root', BOX])
  const id = started[3]
  expect(id).toMatch(/^fix-the-login-page-[a-z0-9]{4}$/)
  const parsed = parseEnvelope(JSON.parse(files.get(`${BOX}/copilot/tasks/${id}/task.json`)))
  expect(parsed.ok).toBe(true)
  const envelope: any = parsed.ok ? parsed.value : null
  expect(envelope.kind).toBe('task')
  expect(envelope.fromId).toBe('self-1')
  expect(envelope.body.task).toBe('Fix the login page')
  expect(envelope.caps.wake_limit).toBe(25)
  expect(envelope.context.git).toMatchObject({ repo_root: 'C:/code/proj', main_root: 'C:/code/proj', is_worktree: false, branch: 'main', head_sha: SHA })
  expect(envelope.context.host).toEqual({ surface: 'desktop-code-tab', emulator: 'unknown', os: 'windows', shell: 'powershell' })
  expect(envelope.context.claude).toMatchObject({ profile: 'work', session_id: 'self-1', model: 'fable' })
  expect(envelope.context.instructions).toEqual([{ path: 'AGENTS.md', bytes: 5 }])
  expect(envelope.context.files_touched).toEqual(['src/login.ts'])
  expect(text).toMatch(new RegExp(`^Copilot task ${id} started, on branch copilot/${id} cut from main \\(0123456789ab\\)`))
  expect(text).toMatch(/Your uncommitted changes \(1 file\) are not in its worktree/)
})

test('a session in a worktree hands over the main working tree as the place for Copilot\'s worktrees', async ($, on) => {
  const { files, calls } = computer(on, { 'rev-parse': 'C:/code/proj/.claude/worktrees/x\nC:/code/proj/.git\n' })
  await $.session.start(START)
  await say($, 'Tidy up')
  const id = calls.find((a) => a[0] === 'node' && a[2] === 'start')![3]
  const { context } = JSON.parse(files.get(`${BOX}/copilot/tasks/${id}/task.json`))
  expect(context.git.main_root).toBe('C:/code/proj')
  expect(context.git.repo_root).toBe('C:/code/proj/.claude/worktrees/x')
  expect(context.git.is_worktree).toBe(true)
})

test('nothing is handed over with a secret in the task, outside a repository, with no commit, or on an old Node', async ($, on) => {
  const { files, calls } = computer(on, { 'rev-parse': 'FAIL' })
  await $.session.start(START)
  expect(await say($, `Deploy with github_pat_${'a'.repeat(40)}`)).toMatch(/^Not sent: the task holds what looks like a GitHub token/)
  expect(await say($, 'Fix the login page')).toMatch(/need a git repository/)
  expect([...files.keys()].some((k: string) => k.includes('/copilot/tasks/'))).toBe(false)
  expect(calls.some((a) => a[2] === 'start')).toBe(false)
})

test('an old or missing Node is said plainly', async ($, on) => {
  computer(on, {}, 'v20.11.0')
  await $.session.start(START)
  expect(await say($, 'Fix the login page')).toMatch(/Node\.js 22\.18 or newer; this computer has v20\.11\.0/)
})

test('a repository with no commit is said plainly', async ($, on) => {
  computer(on, { status: '# branch.oid (initial)\n# branch.head main\n' })
  await $.session.start(START)
  expect(await say($, 'Fix the login page')).toMatch(/has no commit yet/)
})

test('only the person answers a request, and the answer is a decision file for that task', async ($, on) => {
  const { files } = computer(on)
  await $.session.start(START)
  putState(files, stateOf({}))
  putState(files, stateOf({ task_id: 'theirs-bbbb', origin_id: 'someone-else' }))
  const decision = `${BOX}/copilot/tasks/fix-login-x9q2/decisions/r1.json`
  expect(await say($, 'approve r1', { kind: 'plugin', name: 'other' })).toMatch(/^Only you can answer/)
  expect(files.has(decision)).toBe(false)
  expect(await say($, 'approve r9')).toMatch(/No task of this session is waiting on r9/)
  expect(await say($, 'approve r1 theirs-bbbb')).toMatch(/This session has no task theirs-bbbb/)
  expect(await say($, 'allow r1')).toBe('Allowed for the rest of the task: r1 of fix-login-x9q2.')
  expect(JSON.parse(files.get(decision))).toEqual({ request_id: 'r1', decision: 'allow_task', decided_by: 'command', at: NOW })
  const status = (await say($, 'status')).split('\n')
  expect(status[0]).toMatch(/^fix-login-x9q2: awaiting approval.*Waiting for you: \/copilot approve r1\.$/)
  // gh answers nothing on this pretend computer, so the meter line says it couldn't be read.
  expect(status[1]).toMatch(/^GitHub's Copilot meter could not be read/)
})

test('stop asks a running task to stop, and says so of one that has ended', async ($, on) => {
  const { files } = computer(on)
  await $.session.start(START)
  expect(await say($, 'status')).toMatch(/has handed Copilot no tasks/)
  putState(files, stateOf({ state: 'working', pending: [] }))
  expect(await say($, 'stop')).toMatch(/^Stopping fix-login-x9q2/)
  expect(files.has(`${BOX}/copilot/tasks/fix-login-x9q2/stop`)).toBe(true)
  putState(files, stateOf({ state: 'completed', pending: [] }))
  expect(await say($, 'stop fix-login-x9q2')).toMatch(/has already ended \(completed\)/)
  expect(await say($, 'help')).toMatch(/\/copilot <task> hands the task/)
})

test('a running task is a Crosstalk peer: a session can send it a follow-up by its address', async ($, on) => {
  const { files } = computer(on)
  await $.session.start(START)
  files.set(`${BOX}/sessions/copilot-fix-login-x9q2.json`, JSON.stringify({
    id: 'copilot-fix-login-x9q2', profile: 'copilot', address: 'copilot/fix-login-x9q2', alias: 'copilot/fix-login-x9q2',
    cwd: 'C:/code/proj-copilot/fix-login-x9q2', title: 'Copilot: Fix login', startedAt: NOW, seenAt: NOW,
  }))
  const sent = (await $.command.run({ command: 'crosstalk', args: 'to copilot/fix-login-x9q2 also update the changelog' })).text as string
  expect(sent).toMatch(/^Sent to /)
  const name = [...files.keys()].find((k: string) => k.startsWith(`${BOX}/inbox/copilot-fix-login-x9q2/`))!
  const message = JSON.parse(files.get(name))
  // what the sidecar checks before it runs a follow-up: who it is from
  expect(message.fromId).toBe('self-1')
  expect(message.text).toBe('also update the changelog')
})

test('a permission request in the inbox is shown to the person and never starts a turn', async ($, on) => {
  const { files } = computer(on)
  const submitted: string[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text, origin: e.origin } })
  await $.session.start(START)
  const body: PermissionRequestBody = { task_id: 'fix-login-x9q2', request_id: 'r1', tool_kind: 'shell', title: 'Check', command: 'npm test', scope: 'none', risk: 'high', task_grant: 'commands starting "npm test"', expires_at: NOW + 1 }
  const request = makeEnvelope({ id: 'p1', thread_id: 't', from: 'copilot/fix-login-x9q2', fromId: 'copilot-fix-login-x9q2', to: 'work/proj-self', sent_at: NOW, kind: 'permission_request', body, text: permissionText(body) })
  expect(personOnly(request)?.log).toContain('npm test')
  expect(personOnly({ from: 'a', text: 'hello' })).toBeNull()
  expect(personOnly({ ...request, kind: 'reply' })).toBeNull()
  expect(personOnly({ ...request, kind: 'permission_decision' })).toEqual({ toast: '', log: '' })
  files.set(`${BOX}/inbox/self-1/000000001000000-a.json`, JSON.stringify(request))
  files.tick()
  await settle()
  expect(submitted.length).toBe(0)
  expect(files.toasts.at(-1)).toMatch(/Copilot is waiting for your answer: \/copilot approve r1/)
  expect(files.logs.at(-1)).toContain('npm test')
  expect(JSON.parse(files.get(`${BOX}/inbox/self-1/_delivered.json`))).toEqual(['000000001000000-a.json'])
})
