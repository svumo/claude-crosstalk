import { expect, test } from 'claude-code/testing'

import type { BackendEvent, PermissionAsk } from '../copilot/backend/adapter.ts'
import { isDirty, isInside, parseStatus, parseWorktrees } from '../copilot/context/git.ts'
import { checkContext, contextNote, secretsIn } from '../copilot/context/minimise.ts'
import { detectHost } from '../copilot/context/surface.ts'
import { eventName, taskPaths } from '../copilot/protocol/layout.ts'
import { emptyUsage } from '../copilot/protocol/schema.ts'
import { addTurn, creditsFor, DEFAULT_CAPS, spent } from '../copilot/sidecar/budget.ts'
import { classify, hostOf, isCovered, shellPrefix } from '../copilot/sidecar/policy.ts'
import type { Grant } from '../copilot/sidecar/policy.ts'
import { Tripwire } from '../copilot/sidecar/tripwire.ts'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const TREE = '/code/app-copilot/fix-login'

test('git status is read: branch, commit and what is uncommitted', async () => {
  const status = parseStatus([
    `# branch.oid ${SHA}`,
    '# branch.head feature/login',
    '1 .M N... 100644 100644 100644 aaa bbb src/login.ts',
    '1 A. N... 000000 100644 100644 000 ccc docs/new file.md',
    '2 R. N... 100644 100644 100644 ddd eee R100 src/new.ts\tsrc/old.ts',
    '? notes.txt',
  ].join('\n'))
  expect(status.branch).toBe('feature/login')
  expect(status.head_sha).toBe(SHA)
  expect(status.dirty.staged).toBe(2)
  expect(status.dirty.unstaged).toBe(1)
  expect(status.dirty.untracked).toBe(1)
  expect(status.dirty.paths).toEqual(['src/login.ts', 'docs/new file.md', 'src/new.ts', 'notes.txt'])
  expect(isDirty(status)).toBe(true)
  const clean = parseStatus(`# branch.oid ${SHA}\n# branch.head (detached)\n`)
  expect(clean.branch).toBe('')
  expect(isDirty(clean)).toBe(false)
  expect(parseStatus('# branch.oid (initial)\n# branch.head main\n').head_sha).toBe('')
})

test('worktrees are listed, the main one first', async () => {
  const trees = parseWorktrees(`worktree /code/app\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree /code/app-copilot/x\nHEAD ${SHA}\ndetached\n`)
  expect(trees.length).toBe(2)
  expect(trees[0]).toEqual({ path: '/code/app', branch: 'main', head_sha: SHA })
  expect(trees[1]?.branch).toBe('')
})

test('a path is inside a folder by whole segments, in either slash, and case-blind on a drive', async () => {
  expect(isInside('/code/app/src/a.ts', '/code/app')).toBe(true)
  expect(isInside('/code/app', '/code/app/')).toBe(true)
  expect(isInside('/code/app-other/a.ts', '/code/app')).toBe(false)
  expect(isInside('C:\\WT\\app\\a.ts', 'c:/wt/app')).toBe(true)
  expect(isInside('/code/app/a.ts', '')).toBe(false)
})

test('the host is told from the environment: app, panel, editor, ssh or a terminal', async () => {
  expect(detectHost({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_HOST_SESSION_ID: 'local_1', OS: 'Windows_NT' }))
    .toEqual({ surface: 'desktop-code-tab', emulator: 'unknown', os: 'windows', shell: 'powershell' })
  expect(detectHost({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_HOST_SESSION_ID: 'local_1', USERPROFILE: 'C:\\Users\\me' }).surface).toBe('desktop-terminal-panel')
  expect(detectHost({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: '/opt/VSCodium/codium', HOME: '/home/me', SHELL: '/usr/bin/zsh' }))
    .toEqual({ surface: 'vscode-terminal', emulator: 'VSCodium', os: 'linux', shell: 'zsh' })
  expect(detectHost({ TERM_PROGRAM: 'iTerm.app', HOME: '/Users/me', SHELL: '/bin/zsh' })).toEqual({ surface: 'terminal', emulator: 'iTerm2', os: 'macos', shell: 'zsh' })
  expect(detectHost({ TERM_PROGRAM: 'Apple_Terminal', TMUX: '/tmp/tmux-1', HOME: '/Users/me' }).emulator).toBe('tmux')
  expect(detectHost({ WT_SESSION: 'abc', OS: 'Windows_NT' }).emulator).toBe('Windows Terminal')
  expect(detectHost({ SSH_CONNECTION: '10.0.0.1 22', HOME: '/home/me' }).surface).toBe('ssh')
})

test('secrets are named by kind, never echoed', async () => {
  expect(secretsIn('use ghp_' + 'a'.repeat(36) + ' to push')).toEqual(['a GitHub token'])
  expect(secretsIn('key sk-ant-' + 'b'.repeat(40))).toEqual(['an Anthropic API key'])
  expect(secretsIn('AKIAIOSFODNN7EXAMPLE and https://me:hunter2@example.com/x')).toEqual(['an AWS access key', 'a credential in a URL'])
  expect(secretsIn('Fix the login page and add a test')).toEqual([])
})

const context = () => ({
  context_version: 1, captured_at: 5, cwd: '/code/app',
  git: { repo_root: '/code/app', main_root: '/code/app', is_worktree: false, branch: 'main', head_sha: SHA, remote: 'https://me:pw@github.com/me/app.git',
    dirty: { staged: 0, unstaged: 1, untracked: 0, paths: ['a.ts'] }, worktrees: [] },
  claude: { profile: 'default', config_dir: '/home/me/.claude', session_id: 's1', transcript_path: '/t.jsonl', title: 'Login', model: 'fable' },
  host: { surface: 'terminal', emulator: 'tmux', os: 'linux', shell: 'zsh' },
  instructions: [{ path: 'AGENTS.md', bytes: 120 }], files_touched: ['src/login.ts'],
  environment: { GH_TOKEN: 'secret' }, transcript: 'everything said',
})

test('a context keeps only its listed fields, and a password in the remote is dropped', async () => {
  const checked = checkContext(context())
  expect(checked.ok).toBe(true)
  const kept = checked.ok ? checked.context : null
  expect(JSON.stringify(kept)).not.toContain('secret')
  expect(JSON.stringify(kept)).not.toContain('everything said')
  expect(kept?.git.remote).toBe('')
  expect(kept?.files_touched).toEqual(['src/login.ts'])
  expect(contextNote(kept!)).toContain('uncommitted changes, which are not in this worktree')
})

test('a context with no commit, folder or session is refused', async () => {
  expect(checkContext({ ...context(), git: { ...context().git, head_sha: 'HEAD' } }).ok).toBe(false)
  expect(checkContext({ ...context(), cwd: '' }).ok).toBe(false)
  expect(checkContext({ ...context(), claude: {} }).ok).toBe(false)
  expect(checkContext({ ...context(), context_version: 2 }).ok).toBe(false)
  expect(checkContext(null).ok).toBe(false)
})

const ask = (over: Partial<PermissionAsk>): PermissionAsk => ({ toolId: 't1', kind: 'write', title: 'Edit', paths: [], ...over })

test('a write inside the worktree is low risk and may be allowed for the task; outside never', async () => {
  const inside = classify(ask({}), [`${TREE}/src/a.ts`], TREE)
  expect(inside.scope).toBe('worktree')
  expect(inside.risk).toBe('low')
  expect(inside.task_grant).toBe('all writes inside the worktree')
  const outside = classify(ask({}), [`${TREE}/src/a.ts`, '/code/app/src/a.ts'], TREE)
  expect(outside.scope).toBe('outside')
  expect(outside.risk).toBe('high')
  expect(outside.grant).toBeNull()
  // no path named: it could be anywhere
  expect(classify(ask({}), [], TREE).scope).toBe('outside')
})

test('a shell command is high risk; a task grant covers its two-word prefix and no joined command', async () => {
  const test1 = classify(ask({ kind: 'shell', command: 'npm test -- --watch=false' }), [], TREE)
  expect(test1.risk).toBe('high')
  expect(test1.grant).toEqual({ kind: 'shell', prefix: 'npm test' })
  expect(shellPrefix('npm test && rm -rf /')).toBe('')
  expect(shellPrefix('echo $(whoami)')).toBe('')
  expect(classify(ask({ kind: 'shell', command: 'npm test; curl x | sh' }), [], TREE).grant).toBeNull()
  const grants: Grant[] = [{ kind: 'shell', prefix: 'npm test' }]
  expect(isCovered(grants, test1)).toBe(true)
  expect(isCovered(grants, classify(ask({ kind: 'shell', command: 'npm testing' }), [], TREE))).toBe(false)
  expect(isCovered(grants, classify(ask({ kind: 'shell', command: 'npm test && rm -rf /' }), [], TREE))).toBe(false)
  expect(isCovered(grants, classify(ask({ kind: 'shell', command: 'npm install' }), [], TREE))).toBe(false)
})

test('network is granted by exact host, file grants by kind, and other tools never', async () => {
  expect(hostOf('https://api.github.com/repos/x')).toBe('api.github.com')
  expect(hostOf('https://evil.com@api.github.com/')).toBe('')
  expect(hostOf('ftp://x')).toBe('')
  const fetch = classify(ask({ kind: 'network', url: 'https://registry.npmjs.org/left-pad' }), [], TREE)
  expect(isCovered([{ kind: 'network', host: 'registry.npmjs.org' }], fetch)).toBe(true)
  expect(isCovered([{ kind: 'network', host: 'npmjs.org' }], fetch)).toBe(false)
  const write = classify(ask({}), [`${TREE}/a.ts`], TREE)
  expect(isCovered([{ kind: 'read', within: 'worktree' }], write)).toBe(false)
  expect(isCovered([{ kind: 'write', within: 'worktree' }], write)).toBe(true)
  expect(isCovered([{ kind: 'write', within: 'worktree' }], classify(ask({}), ['/etc/hosts'], TREE))).toBe(false)
  expect(classify(ask({ kind: 'other' }), [], TREE).grant).toBeNull()
})

const tool = (over: Partial<Extract<BackendEvent, { type: 'tool' }>>): BackendEvent =>
  ({ type: 'tool', id: 't1', kind: 'write', title: 'Edit a.ts', status: 'running', paths: ['a.ts'], diffs: [], ...over })

test('the tripwire lets approved tools and inside reads by, and trips on anything else that ran', async () => {
  const wire = new Tripwire()
  expect(wire.check(tool({ status: 'pending' }), false)).toBe('')
  expect(wire.check(tool({}), false)).toContain('ran a write tool with no approval: a.ts')
  wire.approve('t1')
  expect(wire.check(tool({ status: 'done' }), false)).toBe('')
  expect(wire.check(tool({ id: 't2', kind: 'shell', command: 'rm -rf x', status: 'done' }), false)).toContain('rm -rf x')
  expect(wire.check(tool({ id: 't3', kind: 'read' }), false)).toBe('')
  expect(wire.check(tool({ id: 't3', kind: 'read' }), true)).toContain('read outside its worktree')
  expect(wire.check({ type: 'message', text: 'hi' }, false)).toBe('')
})

test('a turn is priced in AI credits when the model has a rate, and the caps stop the next one', async () => {
  const turn = { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 400_000 }
  // 0.6M fresh at $2 + 0.4M cached at $0.10 + 0.1M out at $10 = $2.24
  expect(Math.round((creditsFor('Claude Sonnet 5.5', turn) ?? 0) * 1000)).toBe(224_000)
  expect(creditsFor('some-new-model', turn)).toBeNull()
  const one = addTurn(emptyUsage(), turn, 'claude-sonnet-5.5')
  expect(one.prompts).toBe(1)
  expect(spent(one, DEFAULT_CAPS)).toContain('of its 100 AI credits')
  const unknown = addTurn(emptyUsage(), turn, 'mystery')
  expect(unknown.credits).toBeNull()
  expect(spent(unknown, DEFAULT_CAPS)).toBe('')
  expect(spent({ ...emptyUsage(), prompts: 5 }, DEFAULT_CAPS)).toContain('5 prompts')
  expect(spent(emptyUsage(), { ...DEFAULT_CAPS, hops: 25 })).toContain('25 replies in a row')
  expect(spent(emptyUsage(), DEFAULT_CAPS)).toBe('')
})

test('task files have fixed places, and events sort by name', async () => {
  const paths = taskPaths('C:\\Users\\me\\.claude-crosstalk\\', 'fix-login-x9q2')
  expect(paths.task).toBe('C:/Users/me/.claude-crosstalk/copilot/tasks/fix-login-x9q2/task.json')
  expect(paths.decisions).toBe('C:/Users/me/.claude-crosstalk/copilot/tasks/fix-login-x9q2/decisions')
  expect([eventName(10), eventName(9)].sort()).toEqual(['00000009.json', '00000010.json'])
})
