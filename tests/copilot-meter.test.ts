import { expect, test } from 'claude-code/testing'

import { blockBars, intoBand, pickShown, ringLine, ringPercent, ringSvg, shortId, taskPieces } from '../copilot/mod/meter.ts'
import type { TaskStateFile } from '../copilot/protocol/layout.ts'
import { credits, movedLine, parseQuota, quotaLine, resetLabel } from '../copilot/protocol/quota.ts'
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
  expect(resetLabel('2026-12-01')).toBe('1 Dec')
  expect(resetLabel('soon')).toBe('')
  expect(quotaLine(QUOTA)).toBe('GitHub Copilot this month: 5,642 of 50,000 AI credits used (11%), resets 1 Dec.')
})

test('the copilot ring is skins\' ring in purple: fills in when it changes, settled otherwise', async () => {
  const ring = ringSvg(ringPercent(QUOTA), 'copilot', true)
  expect(ring.alt).toBe('copilot 11%')
  expect(ring.height).toBe(30)
  expect(ring.source).toMatch(/<circle class="fill" cx="13" cy="15" r="9"[^>]*stroke="#bd93f9" stroke-width="3"/)
  expect(ring.source).toMatch(/>11%<\/tspan><tspan style="fill:#6272a4"> copilot</)
  expect(ring.source).toMatch(/\.fill\{animation:fill 900ms/)
  expect(ring.source).not.toMatch(/animation:none!important/)
  expect(ringSvg(11, 'copilot', false).source).toMatch(/animation:none!important/)
  // Orange from 80%, red from 95%, as skins' own rings.
  expect(ringSvg(85, 'copilot', false).source).toMatch(/stroke="#ffb86c" stroke-width="3" stroke-linecap/)
  expect(ringSvg(97, 'copilot', false).source).toMatch(/stroke="#ff5555" stroke-width="3" stroke-linecap/)
  expect(ringLine(11, 'copilot')).toEqual({ bar: '█░░░░░░░', text: '11% copilot', color: '#bd93f9' })
  expect(ringLine(50, 'copilot').bar).toBe('████░░░░')
  // Skins' terminal bars are redrawn in the same blocks; other text is left alone.
  const skins = { type: 'Text', props: { color: 'grey' }, children: [{ type: 'Text', props: { color: 'blue' }, children: ['▰▰▰▱▱▱▱▱'] }, ' 39% 7d'] }
  const redrawn: any = blockBars(skins)
  expect(redrawn.children[0].children[0]).toBe('███░░░░░')
  expect(redrawn.children[0].props.color).toBe('blue')
  expect(redrawn.children[1]).toBe(' 39% 7d')
  const plain = { type: 'Text', props: {}, children: ['no bars ▰ here'] }
  expect(blockBars(plain)).toBe(plain)
  expect(ringPercent({ ...QUOTA, unlimited: true })).toBe(0)
})

test('the ring joins the skins meters, after 7d, and stays apart when there is no band', async () => {
  // The skins band as token-ledger leaves it: the meters packed left, then a spacer and Compact.
  const svg = (label: string) => ({ type: 'Svg', props: { alt: label }, children: [] })
  const band = { type: 'Box', props: { flexDirection: 'column' }, children: [
    { type: 'Box', props: { flexDirection: 'row', alignItems: 'center', columnGap: 2 }, children: [
      { type: 'Box', props: { flexDirection: 'row', alignItems: 'center', columnGap: 3, justifyContent: 'flex-start', flexGrow: 1 }, children: [svg('context'), svg('5h'), svg('7d')] },
      { type: 'Button', props: { label: 'Compact' }, children: [] },
    ] },
  ] }
  const joined: any = intoBand(band, [svg('copilot')], [svg('claude')])
  expect(joined.joined).toBe(true)
  expect(joined.node.children[0].children[0].children.map((c: any) => c.props.alt)).toEqual(['claude', 'context', '5h', '7d', 'copilot'])
  expect(band.children[0]!.children[0]!.children.length).toBe(3)
  expect(intoBand({ type: 'Box', props: { flexDirection: 'row' }, children: [] }, [svg('copilot')]).joined).toBe(false)
  expect(intoBand(null, [svg('copilot')]).joined).toBe(false)
})

test('the task beside the ring has a live dot while Copilot works', async () => {
  const words = (pieces: { text: string }[]) => pieces.map((p) => p.text).join(' ')
  expect(words(taskPieces(stateOf({}), NOW, 140))).toBe('● 7t70 working 2m · 46.8k tok')
  expect(words(taskPieces(stateOf({ state: 'awaiting_approval', pending: ['r1'] }), NOW, 140))).toBe('● 7t70 waiting: /copilot approve r1')
  expect(words(taskPieces(stateOf({ state: 'completed' }), NOW, 140))).toBe('✓ 7t70 completed 5s ago · 46.8k tok')
  expect(words(taskPieces(stateOf({}), NOW, 60))).toBe('● 7t70 working 2m')
  // Green while working, orange while it waits on the person.
  expect(taskPieces(stateOf({}), NOW, 140)[0]!.color).toBe('#50fa7b')
  expect(taskPieces(stateOf({ state: 'awaiting_approval' }), NOW, 140)[0]!.color).toBe('#ffb86c')
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
