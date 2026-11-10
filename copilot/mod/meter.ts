// The Copilot row above the prompt: the account's monthly meter from GitHub, then this session's
// Copilot task as it stands. Pure: it returns coloured pieces of text, and register.ts draws them.
//
//   copilot ▰▱▱▱▱▱▱▱ 11% · 5,642/50k cr · resets 1 Dec    ● 7t70 working 2m · 46.6k tok
//
// The ● is the sign that Copilot is at work: green while it works, orange while it waits on the
// person, grey once a turn has ended and it waits for a follow-up.

import type { TaskStateFile } from "../protocol/layout.ts";
import { bar, credits, resetLabel } from "../protocol/quota.ts";
import type { Quota } from "../protocol/quota.ts";
import { FINAL_STATES } from "../protocol/schema.ts";

// The Dracula colours token-ledger uses, so the two rows read as one.
export const PALETTE = { accent: "#bd93f9", green: "#50fa7b", cyan: "#8be9fd", orange: "#ffb86c", red: "#ff5555", pink: "#ff79c6", fg: "#f8f8f2", muted: "#6272a4" };

export type Piece = { text: string; color: string; bold?: boolean };

// How long a finished task stays on the row.
export const DONE_SHOWN_MS = 10 * 60_000;

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)).replace(/\.0(?=[kM])/, "");

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

// The task's short name: its random tail (`add-a-file-…-7t70` → `7t70`).
export const shortId = (taskId: string): string => taskId.slice(taskId.lastIndexOf("-") + 1) || taskId;

// The task the row speaks of: the newest that is still running, else the newest that ended lately.
export function pickShown(states: TaskStateFile[], now: number): TaskStateFile | null {
  const newest = [...states].sort((a, b) => b.started_at - a.started_at);
  return newest.find((s) => !FINAL_STATES.includes(s.state)) ?? newest.find((s) => now - s.updated_at < DONE_SHOWN_MS) ?? null;
}

export const isLive = (state: TaskStateFile | null): boolean => state !== null && !FINAL_STATES.includes(state.state);

function meterPieces(quota: Quota | null, failed: boolean, columns: number): Piece[] {
  const label: Piece = { text: "copilot", color: PALETTE.accent, bold: true };
  if (!quota) {
    return failed ? [label, { text: "meter unavailable (gh api copilot_internal/user)", color: PALETTE.muted }] : [label];
  }
  if (quota.unlimited) {
    return [label, { text: "premium unlimited", color: PALETTE.green }];
  }
  const p = quota.percentUsed;
  const tone = p >= 90 ? PALETTE.red : p >= 75 ? PALETTE.orange : PALETTE.green;
  const pieces: Piece[] = [label, { text: bar(p), color: tone }, { text: `${Math.round(p)}%`, color: tone, bold: true }];
  if (columns >= 70) {
    pieces.push({ text: "·", color: PALETTE.muted }, { text: `${credits(quota.used)}/${credits(quota.entitlement, true)} cr`, color: PALETTE.cyan });
  }
  const reset = resetLabel(quota.resetDate);
  if (reset && columns >= 100) {
    pieces.push({ text: "·", color: PALETTE.muted }, { text: `resets ${reset}`, color: PALETTE.muted });
  }
  if (quota.overage > 0) {
    pieces.push({ text: `+${credits(quota.overage)} over`, color: PALETTE.red });
  }
  return pieces;
}

function taskPieces(state: TaskStateFile, now: number, columns: number): Piece[] {
  const id = shortId(state.task_id);
  const used = state.usage.input_tokens + state.usage.output_tokens;
  const spent: Piece[] = used > 0 && columns >= 90 ? [{ text: "·", color: PALETTE.muted }, { text: `${tokens(used)} tok`, color: PALETTE.fg }] : [];
  switch (state.state) {
    case "starting":
    case "working":
      return [{ text: "●", color: PALETTE.green }, { text: id, color: PALETTE.pink }, { text: `${state.state} ${ago(now - state.started_at)}`, color: PALETTE.green }, ...spent];
    case "awaiting_approval": {
      const ask = state.pending[0] ? `/copilot approve ${state.pending[0]}` : "needs you";
      return [{ text: "●", color: PALETTE.orange }, { text: id, color: PALETTE.pink }, { text: `waiting: ${ask}`, color: PALETTE.orange, bold: true }];
    }
    case "idle":
      return [{ text: "●", color: PALETTE.muted }, { text: id, color: PALETTE.pink }, { text: "turn done", color: PALETTE.muted }, ...spent];
    default: {
      const mark = state.state === "completed" ? { text: "✓", color: PALETTE.green } : { text: "✗", color: PALETTE.red };
      return [mark, { text: id, color: PALETTE.pink }, { text: `${state.state} ${ago(now - state.updated_at)} ago`, color: PALETTE.muted }, ...spent];
    }
  }
}

// The row's two sides, or null when there is nothing to show: no meter reading yet and no task.
export function meterRow(quota: Quota | null, failed: boolean, shown: TaskStateFile | null, now: number, columns: number): { left: Piece[]; right: Piece[] } | null {
  if (!quota && !failed && !shown) {
    return null;
  }
  return { left: meterPieces(quota, failed, columns), right: shown ? taskPieces(shown, now, columns) : [] };
}
