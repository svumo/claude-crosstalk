import { expect, test } from 'claude-code/testing'

import { meterRow, pickShown, shortId } from '../copilot/mod/meter.ts'
import type { TaskStateFile } from '../copilot/protocol/layout.ts'
import { bar, credits, movedLine, parseQuota, quotaLine, resetLabel } from '../copilot/protocol/quota.ts'
import { replyText } from '../copilot/protocol/render.ts'
import { emptyUsage } from '../copilot/protocol/schema.ts'

const NOW = 10_000_000
// The shape `gh api copilot_internal/user` answers with, trimmed to what is read.
const answer = (premium: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  login: 'me', copilot_plan: 'business', quota_reset_date: '2026-12-01',
  quota_snapshots: {
    chat: { unlimited: true, percent_remaining: 100 },
    premium_interactions: { credits_used: 5642, entitlement: 50000, quota_remaining: 44364.6, percent_remaining: 88.7, unlimited: false, overage_count: 0, overage_permitted: true, ...premium },
  },
  ...extra,
})
const QUOTA = parseQuota(answer({}))!

const stateOf = (over: Partial<TaskStateFile>): TaskStateFile => ({
  task_id: 'add-hello-7t70', state: 'working', detail: '', task: 'Add hello', origin_id: 'self-1', origin_address: 'work/proj',
  branch: 'copilot/add-hello-7t70', worktree: 'C:/w', backend: 'sdk', model: '', usage: { ...emptyUsage(), prompts: 1, input_tokens: 46600, output_tokens: 193, credits: null },
  pending: [], started_at: NOW - 125_000, updated_at: NOW - 5_000, pid: 1, ...over,
})
const words = (row: ReturnType<typeof meterRow>) => row ? [...row.left, ...row.right].map((p) => p.text).join(' ') : null

test('GitHub\'s answer is read into the month\'s premium meter', async () => {
  expect(QUOTA).toEqual({ plan: 'business', used: 5642, entitlement: 50000, remaining: 44364.6, percentUsed: 100 - 88.7, unlimited: false, overagePermitted: true, overage: 0, resetDate: '2026-12-01' })
  expect(parseQuota('not json')).toBe(null)
  expect(parseQuota('{"message":"Not Found"}')).toBe(null)
  expect(Math.round(parseQuota(answer({ percent_remaining: undefined }))!.percentUsed * 1000)).toBe(11284)
  expect(parseQuota(answer({ unlimited: true }))!.percentUsed).toBe(0)
})

test('the meter\'s words: credits, the bar, the reset day', async () => {
  expect(credits(5642)).toBe('5,642')
  expect(credits(50000, true)).toBe('50k')
  expect(credits(12500, true)).toBe('12.5k')
  expect(credits(1250000, true)).toBe('1.3M')
  expect(bar(0)).toBe('▱▱▱▱▱▱▱▱')
  expect(bar(1)).toBe('▰▱▱▱▱▱▱▱')
  expect(bar(50)).toBe('▰▰▰▰▱▱▱▱')
  expect(bar(100)).toBe('▰▰▰▰▰▰▰▰')
  expect(resetLabel('2026-12-01')).toBe('1 Dec')
  expect(resetLabel('soon')).toBe('')
  expect(quotaLine(QUOTA)).toBe('GitHub Copilot this month: 5,642 of 50,000 AI credits used (11%), resets 1 Dec.')
})

test('the row shows the meter, and the task with a live dot while Copilot works', async () => {
  expect(meterRow(null, false, null, NOW, 140)).toBe(null)
  expect(words(meterRow(QUOTA, false, null, NOW, 140))).toBe('copilot ▰▱▱▱▱▱▱▱ 11% · 5,642/50k cr · resets 1 Dec')
  expect(words(meterRow(QUOTA, false, stateOf({}), NOW, 140))).toBe('copilot ▰▱▱▱▱▱▱▱ 11% · 5,642/50k cr · resets 1 Dec ● 7t70 working 2m · 46.8k tok')
  expect(words(meterRow(QUOTA, false, stateOf({ state: 'awaiting_approval', pending: ['r1'] }), NOW, 140))).toMatch(/● 7t70 waiting: \/copilot approve r1$/)
  expect(words(meterRow(QUOTA, false, stateOf({ state: 'completed' }), NOW, 140))).toMatch(/✓ 7t70 completed 5s ago · 46.8k tok$/)
  expect(words(meterRow(null, true, null, NOW, 140))).toBe('copilot meter unavailable (gh api copilot_internal/user)')
  // A narrow terminal keeps the bar and the task, and drops the detail.
  expect(words(meterRow(QUOTA, false, stateOf({}), NOW, 60))).toBe('copilot ▰▱▱▱▱▱▱▱ 11% ● 7t70 working 2m')
  // The dot is green while working, orange while it waits on the person.
  expect(meterRow(QUOTA, false, stateOf({}), NOW, 140)!.right[0]!.color).toBe('#50fa7b')
  expect(meterRow(QUOTA, false, stateOf({ state: 'awaiting_approval' }), NOW, 140)!.right[0]!.color).toBe('#ffb86c')
})

test('the row speaks of the running task, else one that ended lately', async () => {
  const done = stateOf({ task_id: 'old-aaaa', state: 'completed', started_at: NOW - 900_000, updated_at: NOW - 60_000 })
  const live = stateOf({ task_id: 'new-bbbb', started_at: NOW - 1_000 })
  expect(pickShown([done, live], NOW)?.task_id).toBe('new-bbbb')
  expect(pickShown([done], NOW)?.task_id).toBe('old-aaaa')
  expect(pickShown([{ ...done, updated_at: NOW - 3_600_000 }], NOW)).toBe(null)
  expect(shortId('add-a-file-called-hello-md-that-says-hel-7t70')).toBe('7t70')
})

test('a result says how far GitHub\'s meter moved while the task ran', async () => {
  const after = { ...QUOTA, used: 5654 }
  expect(movedLine(QUOTA, after)).toBe('GitHub\'s meter: 5,654 of 50,000 AI credits used this month, up 12 while the task ran (all Copilot use on the account counts; it can lag a few minutes).')
  expect(movedLine(QUOTA, QUOTA)).toMatch(/no change yet \(it can lag a few minutes\)/)
  expect(movedLine(null, after)).toBe('')
  expect(movedLine(QUOTA, { ...after, used: 10, resetDate: '2027-01-01' })).toMatch(/reset while the task ran/)
  const body = {
    task_id: 'add-hello-7t70', outcome: 'completed' as const, summary: 'Done.', diff_stat: '', branch: '', worktree: '', base_sha: '',
    commands: { review: '', merge: '', discard: '' }, usage: emptyUsage(), meter: movedLine(QUOTA, after),
  }
  expect(replyText(body).split('\n').at(-1)).toMatch(/^GitHub's meter: 5,654 of 50,000/)
})
