// The Copilot meter above the prompt: a purple ring for the account's monthly AI credits, drawn
// among the skins mod's context / 5h / 7d rings, then this session's Copilot task. Pure: it
// returns drawings and coloured pieces of text, and register.ts places them.
//
//   ◔ 42% context   ◔ 18% 5h   ◔ 31% 7d   ◔ 11% copilot   ● 7t70 working 2m · 46.8k tok
//
// The ● is the sign that Copilot is at work: green while it works, orange while it waits on the
// person, grey once a turn has ended and it waits for a follow-up.

import type { TaskStateFile } from "../protocol/layout.ts";
import { resetLabel } from "../protocol/quota.ts";
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

// The share the ring shows: the month's premium credits used. An unlimited plan shows none.
export const ringPercent = (quota: Quota): number => (quota.unlimited ? 0 : quota.percentUsed);

// The words beside the ring: `gh · gpt-5 · reset 1 Dec`. The model is the live task's own, else
// the one new tasks use, else `default`; the reset day is left out when GitHub gives none.
export function ringLabel(quota: Quota, model = ""): string {
  const reset = resetLabel(quota.resetDate);
  return ["gh", model.trim() || "default", ...(reset ? [`reset ${reset}`] : [])].join(" · ");
}

// When GitHub's meter can't be read, a word where the ring would be.
export const UNAVAILABLE: Piece = { text: "copilot meter unavailable", color: PALETTE.muted };

export function taskPieces(state: TaskStateFile, now: number, columns: number): Piece[] {
  const id = shortId(state.task_id);
  const used = state.usage.input_tokens + state.usage.output_tokens;
  const spent: Piece[] = used > 0 && columns >= 90 ? [{ text: "·", color: PALETTE.muted }, { text: `${tokens(used)} tok`, color: PALETTE.fg }] : [];
  // A live task that isn't asking: bypass in red, so it's never forgotten, auto muted.
  const mode: Piece[] = state.mode === "bypass" ? [{ text: "bypass", color: PALETTE.red, bold: true }] : state.mode === "auto" ? [{ text: "auto", color: PALETTE.muted }] : [];
  switch (state.state) {
    case "starting":
    case "working":
      return [{ text: "●", color: PALETTE.green }, { text: id, color: PALETTE.pink }, ...mode, { text: `${state.state} ${ago(now - state.started_at)}`, color: PALETTE.green }, ...spent];
    case "awaiting_approval": {
      const ask = state.pending[0] ? `answer ${state.pending[0]}` : "needs you";
      return [{ text: "●", color: PALETTE.orange }, { text: id, color: PALETTE.pink }, ...mode, { text: `waiting: ${ask}`, color: PALETTE.orange, bold: true }];
    }
    case "idle":
      return [{ text: "●", color: PALETTE.muted }, { text: id, color: PALETTE.pink }, { text: "turn done", color: PALETTE.muted }, ...spent];
    default: {
      const mark = state.state === "completed" ? { text: "✓", color: PALETTE.green } : { text: "✗", color: PALETTE.red };
      return [mark, { text: id, color: PALETTE.pink }, { text: `${state.state} ${ago(now - state.updated_at)} ago`, color: PALETTE.muted }, ...spent];
    }
  }
}

// ---- The ring, drawn like the skins mod's context / 5h / 7d rings so it sits among them ----
//
// Same geometry, type and fill-in as skins' usage rings (radius 9, 3px stroke, 12.5px text,
// 900ms fill), in purple (build choice) so Copilot reads apart from Claude's own meters. Like
// skins it turns orange from 80% and red from 95%.

const RING_R = 9;
const FILL_MS = 900;
const TEXT_SIZE = 12.5;
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Inter, sans-serif";
export const RING_COLOR = PALETTE.accent;
// The key on the Copilot row when it is drawn on its own (no skins band beneath this hook).
export const COPILOT_ROW_KEY = "crosstalk-copilot";
const SETTLED = ".fill{animation:none!important}";

const ringColor = (percent: number): string => (percent >= 95 ? PALETTE.red : percent >= 80 ? PALETTE.orange : RING_COLOR);

// Close to skins' own text measure, enough to size the drawing.
const measure = (text: string): number => [...text].reduce((sum, c) => sum + TEXT_SIZE * ("iljtf.,:;|!' ".includes(c) ? 0.3 : "mwMW@%".includes(c) ? 0.82 : c >= "A" && c <= "Z" ? 0.64 : 0.54), 0);

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// One ring with `11% copilot` beside it. `animate` fills it in; otherwise it is drawn settled.
export function ringSvg(percent: number, label: string, animate: boolean): { source: string; width: number; height: number; alt: string } {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const text = `${p}% ${label}`;
  const width = Math.ceil(RING_R * 2 + 12 + measure(text) + 6);
  const height = 30;
  const x = RING_R + 4;
  const circumference = 2 * Math.PI * RING_R;
  const filled = (circumference * p) / 100;
  const style = [
    `text{font-family:${FONT}}`,
    `.fill{animation:fill ${FILL_MS}ms cubic-bezier(.2,.8,.2,1)}`,
    "@keyframes fill{from{stroke-dasharray:0 100}}",
    "@media (prefers-reduced-motion:reduce){.fill{animation:none}}",
    animate ? "" : SETTLED,
  ].join("");
  const body = [
    `<circle cx="${x}" cy="15" r="${RING_R}" fill="none" stroke="${PALETTE.muted}" stroke-opacity=".25" stroke-width="3"/>`,
    `<circle class="fill" cx="${x}" cy="15" r="${RING_R}" fill="none" stroke="${ringColor(p)}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 ${x} 15)"/>`,
    `<text x="${x + RING_R + 8}" y="19.5" font-size="${TEXT_SIZE}"><tspan style="fill:${PALETTE.fg};font-weight:600">${p}%</tspan><tspan style="fill:${PALETTE.muted}"> ${esc(label)}</tspan></text>`,
  ].join("");
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${style}</style>${body}</svg>`,
    width, height, alt: `${label} ${p}%`,
  };
}

// The terminal's version: a bar, then `11% copilot`. Full and light shade blocks (█░), which
// every console font has; skins' ▰▱ are missing from many (Consolas, conhost) and draw as boxes.
const FULL = "█";
const EMPTY = "░";

export function ringLine(percent: number, label: string): { bar: string; text: string; color: string } {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round(p / 12.5);
  return { bar: FULL.repeat(filled) + EMPTY.repeat(8 - filled), text: `${p}% ${label}`, color: ringColor(p) };
}

// Skins' own terminal meters, redrawn in the same blocks so Claude's and Copilot's match: every
// text that is only ▰ and ▱ becomes █ and ░, colours kept. A copy; anything else is untouched.
export function blockBars(node: unknown): unknown {
  if (typeof node === "string") {
    return /^[▰▱]+$/.test(node) ? node.replace(/▰/g, FULL).replace(/▱/g, EMPTY) : node;
  }
  if (Array.isArray(node)) {
    let changed = false;
    const list = node.map((item) => {
      const next = blockBars(item);
      changed ||= next !== item;
      return next;
    });
    return changed ? list : node;
  }
  if (!isEl(node) || node.children === undefined) {
    return node;
  }
  const kids = blockBars(node.children);
  return kids === node.children ? node : { ...node, children: kids };
}

// ---- Joining the skins band ----
//
// Skins draws its meters in a row Box that spreads them (`justifyContent: space-evenly`, which
// token-ledger repacks to `flex-start`) inside the band row. `intoBand` adds `mine` at the end of
// that Box, so the Copilot ring sits after 7d. Elements are frozen, so changed nodes are copies.
// No such Box (skins off, another band) and it reports joined: false.

type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown };

const isEl = (n: unknown): n is Node => n !== null && typeof n === "object" && !Array.isArray(n) && typeof (n as Node).type === "string";

const isMeterBox = (n: Node): boolean =>
  n.type === "Box" && n.props?.flexDirection === "row" && n.props?.flexGrow === 1
  && (n.props?.justifyContent === "space-evenly" || n.props?.justifyContent === "flex-start");

// `lead` goes before skins' meters (the `claude` label), `mine` after them.
export function intoBand(node: unknown, mine: unknown[], lead: unknown[] = []): { node: unknown; joined: boolean } {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const inner = intoBand(node[i], mine, lead);
      if (inner.joined) {
        return { node: node.map((item, j) => (j === i ? inner.node : item)), joined: true };
      }
    }
    return { node, joined: false };
  }
  if (!isEl(node)) {
    return { node, joined: false };
  }
  const kids = Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children];
  if (isMeterBox(node)) {
    return { node: { ...node, children: [...lead, ...kids, ...mine] }, joined: true };
  }
  const inner = intoBand(kids, mine, lead);
  return inner.joined ? { node: { ...node, children: inner.node }, joined: true } : { node, joined: false };
}
