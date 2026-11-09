import { expect, test } from 'claude-code/testing'

import { isTaskId, taskId, taskSlug } from '../copilot/protocol/ids.ts'
import { permissionText, replyText } from '../copilot/protocol/render.ts'
import { emptyUsage, fromV0, makeEnvelope, parseEnvelope } from '../copilot/protocol/schema.ts'
import type { PermissionRequestBody, ReplyBody, TaskBody } from '../copilot/protocol/schema.ts'
import { pendingNames } from '../hooks/core.mjs'

const task = () => makeEnvelope<TaskBody>({
  id: 'm1', thread_id: 't1', from: 'default/proj-ab12', fromId: 'sess-1', to: 'copilot/fix-login-x9q2', sent_at: 1_000,
  kind: 'task', body: { task_id: 'fix-login-x9q2', task: 'Fix the login page' }, text: 'Task for Copilot: Fix the login page',
  caps: { hops: 0, wake_limit: 25, credit_budget: 100, max_prompts: 5 },
})

test('a task is named from its text', async () => {
  expect(taskSlug('Fix the login page!')).toBe('fix-the-login-page')
  expect(taskSlug('  ✨  ')).toBe('task')
  expect(taskSlug('a'.repeat(80)).length).toBe(40)
})

test('a task id is its slug and four characters, and is safe in a path', async () => {
  expect(taskId('Fix the login page', 'x9Q2zz')).toBe('fix-the-login-page-x9q2')
  expect(taskId('', '!')).toBe('task-0000')
  expect(isTaskId(taskId('Refactor: auth/session.ts', 'abcd'))).toBe(true)
  expect(isTaskId('../etc')).toBe(false)
  expect(isTaskId('')).toBe(false)
})

test('a v1 message parses, and is still a message today\'s peers deliver', async () => {
  const envelope = task()
  const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)))
  expect(parsed.ok).toBe(true)
  // What hooks/crosstalk.mjs asks of a message: text is a string. Its file name is a plain inbox name.
  expect(typeof envelope.text).toBe('string')
  expect(envelope.sentAt).toBe(envelope.sent_at)
  expect(pendingNames([{ kind: 'file', name: '000000000001000-abc.json' }], new Set())).toEqual(['000000000001000-abc.json'])
})

test('a message missing what its kind needs is refused, with the reason', async () => {
  const noTask = { ...task(), body: { task_id: 'x' } }
  const parsed = parseEnvelope(noTask)
  expect(parsed.ok).toBe(false)
  expect(parsed.ok ? '' : parsed.error).toContain('body.task')
  expect(parseEnvelope({ ...task(), kind: 'order' }).ok).toBe(false)
  expect(parseEnvelope({ ...task(), schema_version: 2 }).ok).toBe(false)
  expect(parseEnvelope({ ...task(), caps: { hops: -1 } }).ok).toBe(false)
  expect(parseEnvelope('text').ok).toBe(false)
})

test('a decision names who decided, and nothing else passes as one', async () => {
  const decision = { ...task(), kind: 'permission_decision', body: { task_id: 'x', request_id: 'r1', decision: 'approve', decided_by: 'command' } }
  expect(parseEnvelope(decision).ok).toBe(true)
  expect(parseEnvelope({ ...decision, body: { ...decision.body, decided_by: 'model' } }).ok).toBe(false)
  expect(parseEnvelope({ ...decision, body: { ...decision.body, decision: 'yes' } }).ok).toBe(false)
})

test('a v0 message is read as plain text, never as a v1 one', async () => {
  const v0 = { from: 'work/api-1a2b', fromId: 's2', to: 'copilot/x', sentAt: 5, text: 'carry on' }
  const plain = fromV0(v0)
  expect(plain.ok && plain.value.text).toBe('carry on')
  expect(parseEnvelope(v0).ok).toBe(false)
  expect(fromV0(task()).ok).toBe(false)
  expect(fromV0({ from: 'x' }).ok).toBe(false)
})

test('a reply says the outcome, quotes Copilot, and gives the commands', async () => {
  const body: ReplyBody = {
    task_id: 'fix-login-x9q2', outcome: 'completed', summary: 'Fixed the redirect.', diff_stat: ' src/login.ts | 4 ++--',
    branch: 'copilot/fix-login-x9q2', worktree: '/code/app-copilot/fix-login-x9q2', base_sha: '0123456789abcdef0123',
    commands: { review: 'git diff a...b', merge: 'git merge b', discard: 'git worktree remove w' },
    usage: { ...emptyUsage(), prompts: 1, input_tokens: 1200, output_tokens: 300, credits: 0.54 },
  }
  const text = replyText(body)
  expect(text).toContain('Copilot task fix-login-x9q2 finished.')
  expect(text).toContain('its own words, not checked')
  expect(text).toContain('Merge:   git merge b')
  expect(text).toContain('1 prompt, 0.5 AI credits')
  expect(replyText({ ...body, outcome: 'refused', branch: '' })).not.toContain('Merge:')
})

test('a permission request shows the exact command and how only the person answers', async () => {
  const body: PermissionRequestBody = {
    task_id: 't', request_id: 'r7', tool_kind: 'shell', title: 'Run tests', command: 'npm test -- --watch=false',
    scope: 'none', risk: 'high', task_grant: 'npm test', expires_at: 9,
  }
  const text = permissionText(body)
  expect(text).toContain('npm test -- --watch=false')
  expect(text).not.toContain('Run tests')
  expect(text).toContain('/copilot approve r7')
  expect(text).toContain('/copilot allow r7 (npm test, for this task)')
  expect(permissionText({ ...body, task_grant: null })).not.toContain('/copilot allow')
})
