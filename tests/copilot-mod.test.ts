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
const say = async ($: any, args: string, origin: any = { kind: 'composer' }) => (await $.command.run({ command: 'crosstalk-gh', args, origin })).text as string
// Runs out the wait a task holds for pasted pictures, then lets its start finish.
const wake = async (files: any) => {
  for (const fire of files.waits.splice(0)) fire()
  await settle()
}
// A task as the person sends it: the command, then its own submission with nothing pasted... or the wait running out.
const sayTask = async ($: any, files: any, args: string) => {
  const text = await say($, args)
  await wake(files)
  return text
}

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
    if (e.argv[0] === 'gh' && files.gh) return { value: { ...RAN_OK, stdout: files.gh } }
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
  // The wait a /crosstalk-gh task holds for its pasted pictures: fired by the test with `wake()`.
  files.waits = [] as (() => void)[]
  on('clock.after', (_: any, e: any) => new Promise<any>((resolve) => {
    if (e.ms === 2500) files.waits.push(() => resolve({ value: undefined }))
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

test('what follows /crosstalk-gh is a command only in its exact shape, else a task in the person\'s words', async () => {
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
  // modes and models
  expect(parseCopilot('--bypass add a README')).toEqual({ verb: 'task', task: 'add a README', mode: 'bypass' })
  expect(parseCopilot('--mode auto --model gpt-6.1-sol add a README')).toEqual({ verb: 'task', task: 'add a README', mode: 'auto', model: 'gpt-6.1-sol' })
  expect(parseCopilot('--mode=bypass  keep  my spacing')).toEqual({ verb: 'task', task: 'keep  my spacing', mode: 'bypass' })
  expect(parseCopilot('--mode yolo fix it').verb).toBe('error')
  expect(parseCopilot('--bypass').verb).toBe('error')
  expect(parseCopilot('mode')).toEqual({ verb: 'mode', mode: '', taskId: '' })
  expect(parseCopilot('mode bypass')).toEqual({ verb: 'mode', mode: 'bypass', taskId: '' })
  expect(parseCopilot('mode ask fix-login-x9q2')).toEqual({ verb: 'mode', mode: 'ask', taskId: 'fix-login-x9q2' })
  expect(parseCopilot('mode the tests so they pass')).toEqual({ verb: 'task', task: 'mode the tests so they pass' })
  expect(parseCopilot('models')).toEqual({ verb: 'models' })
  expect(parseCopilot('model')).toEqual({ verb: 'models' })
  expect(parseCopilot('model claude-opus-5.5')).toEqual({ verb: 'model', model: 'claude-opus-5.5' })
  expect(parseCopilot('model the data layer')).toEqual({ verb: 'task', task: 'model the data layer' })
})

test('a status line says how a task stands and what waits on the person', async () => {
  expect(statusLine(stateOf({}), NOW)).toBe('fix-login-x9q2: awaiting approval, started 2 min ago, 1 prompt, 0.0 AI credits (0 in, 0 cached, 0 out). Waiting for you: /crosstalk-gh approve r1.')
  const two = [stateOf({}), stateOf({ task_id: 'other-aaaa' })]
  expect(pickTask(two, '', (s) => s.pending.includes('r1'), 'is waiting on r1').error).toMatch(/More than one task is waiting on r1: fix-login-x9q2, other-aaaa/)
  expect(pickTask(two, 'other-aaaa', () => true, 'x').state?.task_id).toBe('other-aaaa')
  expect(pickTask(two, '', () => false, 'is running').error).toMatch(/No task of this session is running/)
})

test('/crosstalk-gh <task> captures the session, writes the handoff and starts the sidecar', async ($, on) => {
  const { files, calls } = computer(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\code\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' } as never).catch(() => {})
  const text = await say($, 'Fix the login page')
  expect(calls.some((a) => a[2] === 'start')).toBe(false)
  await wake(files)
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
  expect(text).toMatch(new RegExp(`^Copilot task ${id} started in ask mode, on branch copilot/${id} from main\\.`))
  expect(text).toMatch(/Your uncommitted changes \(1 file\) aren't in its worktree/)
})

// The kit can't raise the /crosstalk-gh line's own submission (it leaves out `command`), so pictures
// arriving through it are checked live; here, the waits around it.
test('a /crosstalk-gh task waits for its pictures, a prompt that is not its own submission does not start it, and a second task never waits on the first', async ($, on) => {
  const { files, calls } = computer(on)
  await $.session.start(START)
  const starts = () => calls.filter((a) => a[0] === 'node' && a[2] === 'start').map((a) => a[3])
  await say($, 'Look at this')
  await $.prompt.submit({ text: 'something else' }).catch(() => {})
  await settle()
  expect(starts()).toHaveLength(0)
  await say($, 'Second task')
  await settle()
  expect(starts()).toHaveLength(1)
  await wake(files)
  expect(starts()).toHaveLength(2)
  const first = JSON.parse(files.get(`${BOX}/copilot/tasks/${starts()[0]}/task.json`))
  expect(first.body.task).toBe('Look at this')
  expect(first.body.images).toBeUndefined()
})

test('a session in a worktree hands over the main working tree as the place for Copilot\'s worktrees', async ($, on) => {
  const { files, calls } = computer(on, { 'rev-parse': 'C:/code/proj/.claude/worktrees/x\nC:/code/proj/.git\n' })
  await $.session.start(START)
  await sayTask($, files, 'Tidy up')
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
  expect(status[0]).toMatch(/^fix-login-x9q2: awaiting approval.*Waiting for you: \/crosstalk-gh approve r1\.$/)
  // gh answers nothing on this pretend computer, so the meter line says it couldn't be read.
  expect(status[1]).toMatch(/^GitHub's Copilot meter could not be read/)
})

test('Claude runs any /crosstalk-gh command through the crosstalk_gh tool, approvals and mode included', async ($, on) => {
  const { files } = computer(on)
  await $.session.start(START)
  putState(files, stateOf({}))
  const gh = async (args: string) => JSON.stringify(await $.tool.call({ tool: 'mcp__crosstalk__crosstalk_gh', args } as never))
  expect(await gh('help')).toMatch(/crosstalk-gh/)
  expect(await gh('approve r1')).toMatch(/Approved: r1 of fix-login-x9q2\./)
  expect(JSON.parse(files.get(`${BOX}/copilot/tasks/fix-login-x9q2/decisions/r1.json`)).decision).toBe('approve')
  expect(await gh('mode bypass')).toMatch(/Copilot mode: bypass/)
  expect(JSON.parse(files.get(`${BOX}/copilot/config.json`)).mode).toBe('bypass')
})

test('a task from the crosstalk_gh tool starts at once with the pictures it names, and a bad one is refused', async ($, on) => {
  const { files, calls } = computer(on)
  await $.session.start(START)
  files.set('C:/shots/meter.png', 'png bytes')
  const gh = async (args: string, images: string[]) => JSON.stringify(await $.tool.call({ tool: 'mcp__crosstalk__crosstalk_gh', args, images } as never))
  expect(await gh('Fix the meter', ['C:/shots/missing.png'])).toMatch(/Not sent: there is no picture at C:\/shots\/missing\.png/)
  expect(await gh('Fix the meter', ['C:/shots/notes.txt'])).toMatch(/is not a png, jpg, gif or webp picture/)
  expect(await gh('Fix the meter', ['C:/shots/meter.png'])).toMatch(/Copilot task fix-the-meter-\w+ started/)
  const copies = calls.filter((c) => c[0] === 'node' && c[1] === '-e' && String(c[2]).includes('base64'))
  expect(copies.length).toBe(1)
  expect(copies[0][3]).toBe('C:/shots/meter.png')
  expect(slash(copies[0][4])).toMatch(/\/copilot\/tasks\/fix-the-meter-\w+\/attachments\/1\.png\.b64$/)
  const handoff = [...files.keys()].find((k: string) => /\/copilot\/tasks\/fix-the-meter-\w+\/task\.json$/.test(k))!
  expect(JSON.parse(files.get(handoff)).body.images).toEqual(['1.png'])
  // no wait for a pasted picture: the sidecar started without wake()
  expect(calls.some((c) => c[0] === 'node' && String(c[1]).endsWith('/copilot/sidecar/main.ts') && c[2] === 'start')).toBe(true)
})

test('the crosstalk_gh tool cuts the task from the folder it names, not the session\'s own', async ($, on) => {
  const { calls } = computer(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__crosstalk__crosstalk_gh', args: 'Fix the meter', folder: 'C:/code/proj/.claude/worktrees/wt' } as never)
  const gits = calls.filter((c) => c[0] !== 'node' && c[1] === '-C').map((c) => slash(c[2]))
  expect(gits.length).toBeGreaterThan(0)
  expect(gits.every((p) => p === 'C:/code/proj/.claude/worktrees/wt')).toBe(true)
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
  expect(await say($, 'help')).toMatch(/\/crosstalk-gh <task> hands the task/)
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

test('a permission request in the inbox pops up as a dialog, and the pick is a decision file; it never starts a turn', async ($, on) => {
  const { files } = computer(on)
  const submitted: string[] = []
  const asked: any[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text, origin: e.origin } })
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => {
    asked.push(e)
    const q = e.questions[0]
    return { result: { questions: e.questions, answers: { [q.question]: 'Bypass this task' } } }
  })
  await $.session.start(START)
  putState(files, stateOf({}))
  const body: PermissionRequestBody = { task_id: 'fix-login-x9q2', request_id: 'r1', tool_kind: 'shell', title: 'Check', command: 'npm test', scope: 'none', risk: 'high', task_grant: 'commands starting "npm test"', expires_at: NOW + 1 }
  const request = makeEnvelope({ id: 'p1', thread_id: 't', from: 'copilot/fix-login-x9q2', fromId: 'copilot-fix-login-x9q2', to: 'work/proj-self', sent_at: NOW, kind: 'permission_request', body, text: permissionText(body) })
  expect(personOnly(request)?.ask?.command).toBe('npm test')
  expect(personOnly({ from: 'a', text: 'hello' })).toBeNull()
  expect(personOnly({ ...request, kind: 'reply' })).toBeNull()
  expect(personOnly({ ...request, kind: 'permission_decision' })).toEqual({ ask: null })
  files.set(`${BOX}/inbox/self-1/000000001000000-a.json`, JSON.stringify(request))
  files.tick()
  await settle()
  await settle()
  expect(submitted.length).toBe(0)
  expect(files.logs.length).toBe(0)
  expect(asked[0]?.questions[0].question).toBe('Copilot wants to run: npm test (high risk). Allow it?')
  expect(asked[0]?.questions[0].options.map((o: any) => o.label)).toEqual(['Approve', 'Allow for task', 'Deny', 'Bypass this task'])
  expect(JSON.parse(files.get(`${BOX}/copilot/tasks/fix-login-x9q2/decisions/r1.json`))).toEqual({ request_id: 'r1', decision: 'approve', decided_by: 'button', at: NOW })
  expect(JSON.parse(files.get(`${BOX}/copilot/tasks/fix-login-x9q2/mode.json`)).mode).toBe('bypass')
  expect(JSON.parse(files.get(`${BOX}/inbox/self-1/_delivered.json`))).toEqual(['000000001000000-a.json'])
})

test('/crosstalk-gh mode lists or sets the mode, switches running tasks, and only the person may change it', async ($, on) => {
  const { files } = computer(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_: any, e: any) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: 'Auto' } } }))
  await $.session.start(START)
  putState(files, stateOf({ state: 'working', pending: [] }))
  putState(files, stateOf({ task_id: 'done-cccc', state: 'completed', pending: [] }))
  expect(await say($, 'mode bypass', { kind: 'plugin', name: 'other' })).toMatch(/^Only you can change/)
  expect(await say($, 'mode bypass')).toBe('Copilot mode: bypass, approves everything without asking. New tasks start in it; switched the running task too.')
  expect(JSON.parse(files.get(`${BOX}/copilot/config.json`)).mode).toBe('bypass')
  expect(JSON.parse(files.get(`${BOX}/copilot/tasks/fix-login-x9q2/mode.json`)).mode).toBe('bypass')
  expect(files.has(`${BOX}/copilot/tasks/done-cccc/mode.json`)).toBe(false)
  // with no mode named, the picker asks
  expect(await say($, 'mode')).toMatch(/^Copilot mode: auto,/)
  expect(JSON.parse(files.get(`${BOX}/copilot/config.json`)).mode).toBe('auto')
  expect(await say($, '--bypass fix it', { kind: 'plugin', name: 'other' })).toMatch(/^Only you can pick/)
})

// The skins band as the engine hands it on: meters spread across the row, then Compact.
const skinsBand = () => ({
  type: 'Box', props: { flexDirection: 'row', alignItems: 'center', columnGap: 2, paddingRight: 5 },
  children: [
    { type: 'Box', props: { flexDirection: 'row', alignItems: 'center', columnGap: 3, justifyContent: 'space-evenly', flexGrow: 1 }, children: [{ type: 'Text', props: {}, children: ['42% context'] }, { type: 'Text', props: { color: '#8be9fd' }, children: ['▰▰▰▱▱▱▱▱'] }] },
    { type: 'Text', props: {}, children: ['Compact'] },
  ],
})
const QUOTA_ANSWER = JSON.stringify({ copilot_plan: 'business', quota_reset_date: '2026-12-01', quota_snapshots: { premium_interactions: { credits_used: 5642, entitlement: 50000, quota_remaining: 44358, percent_remaining: 88.7, unlimited: false } } })
const mountBand = ($: any, surface: string) => $.ui.mount({
  plugin: 'crosstalk', component: 'AbovePrompt', requestId: 'band', surface, viewport: { columns: 140, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as never)

test('the copilot ring joins the skins meters, after them, with no label in front', async ($, on) => {
  const { files } = computer(on)
  files.gh = QUOTA_ANSWER
  on('ui.render', () => skinsBand())
  await $.session.start(START)
  await settle()
  const desktop = await mountBand($, 'desktop')
  expect(await desktop.find({ type: 'Text', text: 'claude' })).toBeUndefined()
  expect(await desktop.find({ type: 'Text', text: '42% context' })).toBeDefined()
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  await desktop.unmount()
  // The terminal draws Svg as nothing, so it gets block meters, skins' own redrawn to match.
  const terminal = await mountBand($, 'terminal')
  expect(await terminal.find({ type: 'Text', text: '█░░░░░░░' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '███░░░░░' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '▰▰▰▱▱▱▱▱' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: ' 11% gh · default · reset 1 Dec' })).toBeDefined()
  await terminal.unmount()
})

test('the copilot ring names the model new tasks use, from config.json', async ($, on) => {
  const { files } = computer(on)
  files.gh = QUOTA_ANSWER
  files.set(`${BOX}/copilot/config.json`, JSON.stringify({ model: 'gpt-5' }))
  on('ui.render', () => skinsBand())
  await $.session.start(START)
  await settle()
  const terminal = await mountBand($, 'terminal')
  expect(await terminal.find({ type: 'Text', text: ' 11% gh · gpt-5 · reset 1 Dec' })).toBeDefined()
  await terminal.unmount()
})

test('the copilot ring names a running task\'s own model, and a new default at once', async ($, on) => {
  const { files } = computer(on)
  files.gh = QUOTA_ANSWER
  files.set(`${BOX}/copilot/config.json`, JSON.stringify({ model: 'gpt-5' }))
  on('ui.render', () => skinsBand())
  await $.session.start(START)
  putState(files, stateOf({ state: 'working', pending: [], model: 'claude-sonnet-5-5' }))
  expect(await say($, 'model gpt-5-mini')).toBe('New Copilot tasks use gpt-5-mini.')
  await settle()
  const running = await mountBand($, 'terminal')
  expect(await running.find({ type: 'Text', text: ' 11% gh · claude-sonnet-5-5 · reset 1 Dec' })).toBeDefined()
  await running.unmount()
  putState(files, stateOf({ state: 'completed', pending: [], model: 'claude-sonnet-5-5' }))
  expect(await say($, 'model gpt-5-mini')).toBe('New Copilot tasks use gpt-5-mini.')
  await settle()
  const idle = await mountBand($, 'terminal')
  expect(await idle.find({ type: 'Text', text: ' 11% gh · gpt-5-mini · reset 1 Dec' })).toBeDefined()
  await idle.unmount()
})
