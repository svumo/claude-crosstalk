// What the attach viewer prints, and what its keys mean. Pure, so it is tested without a terminal.
//
// Everything Copilot wrote is untrusted: it is stripped of control characters before it reaches
// the terminal, so a message, a command or a file cannot move the cursor, retitle the window or
// hide text with escape sequences.

import type { TaskStateFile } from "../protocol/layout.ts";
import { permissionTarget, usageLine } from "../protocol/render.ts";
import type { Decision, EventBody, PermissionRequestBody } from "../protocol/schema.ts";

// Control characters (but tab and newline), DEL, the C1 range, and the bidirectional overrides
// that can make text read differently from what it is.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
export const clean = (text: unknown): string => String(text ?? "").replace(/\r\n?/g, "\n").replace(UNSAFE, "");

export type Paint = {
  bold: (t: string) => string;
  dim: (t: string) => string;
  red: (t: string) => string;
  green: (t: string) => string;
  yellow: (t: string) => string;
  cyan: (t: string) => string;
  purple: (t: string) => string;
};

const wrap = (on: string, off: string) => (t: string): string => `\u001b[${on}m${t}\u001b[${off}m`;
export const COLOR: Paint = {
  bold: wrap("1", "22"), dim: wrap("2", "22"), red: wrap("31", "39"), green: wrap("32", "39"),
  yellow: wrap("33", "39"), cyan: wrap("36", "39"), purple: wrap("35", "39"),
};
const same = (t: string): string => t;
export const PLAIN: Paint = { bold: same, dim: same, red: same, green: same, yellow: same, cyan: same, purple: same };

// A unified-style line diff of a file Copilot changed: changed lines with two lines of context,
// the rest folded. Longest-common-subsequence, so it is exact; past LCS_CELLS it shows the old
// text removed and the new added, rather than spend seconds on one huge file.
const CONTEXT = 2;
const LCS_CELLS = 400_000;
export type DiffLine = { sign: " " | "-" | "+" | "…"; text: string };

export function lineDiff(before: string | null, after: string | null): DiffLine[] {
  const a = before === null || before === "" ? [] : clean(before).replace(/\n$/, "").split("\n");
  const b = after === null || after === "" ? [] : clean(after).replace(/\n$/, "").split("\n");
  const raw: DiffLine[] = [];
  if (a.length * b.length > LCS_CELLS) {
    raw.push(...a.map((text) => ({ sign: "-" as const, text })), ...b.map((text) => ({ sign: "+" as const, text })));
  } else {
    // lengths[i][j]: the longest common run of a[i..] and b[j..].
    const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        const row = lengths[i] as number[];
        row[j] = a[i] === b[j] ? (lengths[i + 1] as number[])[j + 1] as number + 1 : Math.max((lengths[i + 1] as number[])[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        raw.push({ sign: " ", text: a[i] as string });
        i += 1;
        j += 1;
      } else if (i < a.length && (j >= b.length || ((lengths[i + 1] as number[])[j] as number) >= ((lengths[i] as number[])[j + 1] as number))) {
        // Removed lines before added ones, as a unified diff has them.
        raw.push({ sign: "-", text: a[i] as string });
        i += 1;
      } else {
        raw.push({ sign: "+", text: b[j] as string });
        j += 1;
      }
    }
  }
  // Keep changed lines and CONTEXT lines either side; fold each other run into one "…".
  const keep = raw.map((line) => line.sign !== " ");
  const near = raw.map((_, n) => keep.slice(Math.max(0, n - CONTEXT), n + CONTEXT + 1).some(Boolean));
  const out: DiffLine[] = [];
  raw.forEach((line, n) => {
    if (near[n]) {
      out.push(line);
    } else if (out.at(-1)?.sign !== "…") {
      out.push({ sign: "…", text: "" });
    }
  });
  return out;
}

const DIFF_LINES = 80;

export function diffBlock(path: string, before: string | null, after: string | null, paint: Paint): string[] {
  const lines = lineDiff(before, after);
  const added = lines.filter((l) => l.sign === "+").length;
  const removed = lines.filter((l) => l.sign === "-").length;
  const what = before === null ? "new file" : `+${added} −${removed}`;
  const shown = lines.slice(0, DIFF_LINES).map((l) => {
    if (l.sign === "+") {
      return paint.green(`  + ${l.text}`);
    }
    if (l.sign === "-") {
      return paint.red(`  - ${l.text}`);
    }
    return l.sign === "…" ? paint.dim("  …") : paint.dim(`    ${l.text}`);
  });
  if (lines.length > DIFF_LINES) {
    shown.push(paint.dim(`  … ${lines.length - DIFF_LINES} more lines`));
  }
  return [paint.cyan(`  ${clean(path)}`) + paint.dim(` (${what})`), ...shown];
}

type ToolData = { id?: unknown; kind?: unknown; status?: unknown; command?: unknown; paths?: unknown; diffs?: unknown };
type DiffData = { path?: unknown; before?: unknown; after?: unknown };

// What the viewer remembers between events, so a streamed message reads as one and a tool's
// status changes print once each.
export type ViewMemory = { last: EventBody["type"] | ""; tools: Map<string, string>; diffsShown: Set<string> };
export const newMemory = (): ViewMemory => ({ last: "", tools: new Map(), diffsShown: new Set() });

const STATUS_MARK: Record<string, (p: Paint) => string> = {
  pending: (p) => p.dim("…"), running: (p) => p.yellow("▶"), done: (p) => p.green("✓"), failed: (p) => p.red("✗"),
};

// The lines one event adds to the transcript, given what came before it. May be none.
export function renderEvent(event: EventBody, memory: ViewMemory, paint: Paint): string[] {
  const out: string[] = [];
  const continues = memory.last === event.type && (event.type === "message" || event.type === "thought");
  memory.last = event.type;
  switch (event.type) {
    case "message": {
      if (!continues) {
        out.push("", paint.purple(paint.bold("Copilot:")));
      }
      out.push(...clean(event.text).split("\n"));
      break;
    }
    case "thought": {
      if (!continues) {
        out.push("", paint.dim("(thinking)"));
      }
      out.push(...clean(event.text).split("\n").map((l) => paint.dim(l)));
      break;
    }
    case "plan": {
      const entries = Array.isArray(event.data?.entries) ? event.data.entries : [];
      out.push("", paint.bold("Plan:"), ...entries.map((e, n) => `  ${n + 1}. ${clean(e)}`));
      break;
    }
    case "tool": {
      const data = (event.data ?? {}) as ToolData;
      const id = clean(data.id);
      const status = clean(data.status);
      if (memory.tools.get(id) !== status) {
        memory.tools.set(id, status);
        const command = typeof data.command === "string" && data.command !== "" ? `  ${paint.bold(`$ ${clean(data.command)}`)}` : "";
        const mark = (STATUS_MARK[status] ?? ((p: Paint) => p.dim("·")))(paint);
        out.push(`${mark} ${paint.dim(clean(data.kind))} ${clean(event.text)}${command}`);
      }
      const diffs = Array.isArray(data.diffs) ? (data.diffs as DiffData[]) : [];
      // A file's diff once, when the tool has finished with it.
      if (status === "done" || status === "failed") {
        for (const diff of diffs) {
          const key = `${id}\u0000${clean(diff.path)}`;
          if (!memory.diffsShown.has(key) && typeof diff.after === "string") {
            memory.diffsShown.add(key);
            out.push(...diffBlock(String(diff.path ?? ""), typeof diff.before === "string" ? diff.before : null, diff.after, paint));
          }
        }
      }
      break;
    }
    case "state": {
      const detail = typeof event.data?.detail === "string" ? ` ${paint.dim(clean(event.data.detail))}` : "";
      // "working" follows every answered request: not worth a line of its own.
      if (event.text !== "working" || detail !== "") {
        out.push(paint.dim(`— ${clean(event.text).replace(/_/g, " ")}`) + detail);
      }
      break;
    }
    case "permission": {
      // A request is drawn as a card from its request file; here only what became of it.
      if (typeof event.data?.tool_kind !== "string") {
        out.push(paint.dim(`— ${clean(event.text)}`));
      }
      break;
    }
    default:
      if (event.text) {
        out.push(paint.dim(clean(event.text)));
      }
  }
  return out;
}

// The line at the top: which task, where it stands, and what it has used.
export function headerLines(state: TaskStateFile | null, taskId: string, paint: Paint): string[] {
  if (!state) {
    return [paint.bold(`Copilot task ${taskId}`), paint.dim("Waiting for the task to start…")];
  }
  const mode = state.mode && state.mode !== "ask" ? ` · ${state.mode}` : "";
  const model = state.model ? ` · ${clean(state.model)}` : "";
  return [
    paint.bold(`Copilot task ${state.task_id}`) + paint.dim(` · ${state.backend}${model}${mode}`),
    paint.dim(`Branch ${clean(state.branch) || "(not yet)"} · worktree ${clean(state.worktree) || "(not yet)"}`),
    paint.dim(`Task: ${clean(state.task).split("\n")[0]?.slice(0, 200) ?? ""}`),
  ];
}

export const usageText = (state: TaskStateFile): string => usageLine(state.usage);

const WHAT: Record<PermissionRequestBody["tool_kind"], string> = {
  read: "read", write: "write to", shell: "run a command", network: "use the network", other: "use a tool",
};

// A request waiting for the person, with the keys that answer it.
export function requestCard(body: PermissionRequestBody, now: number, paint: Paint): string[] {
  const where = { worktree: "inside its worktree", outside: paint.red("OUTSIDE its worktree"), none: "" }[body.scope];
  const risk = body.risk === "high" ? paint.red("high risk") : paint.green("low risk");
  const left = Math.max(0, Math.round((body.expires_at - now) / 60_000));
  const keys = [`${paint.bold("y")} approve`, ...(body.task_grant ? [`${paint.bold("a")} allow ${clean(body.task_grant)} for this task`] : []), `${paint.bold("n")} deny`];
  return [
    "",
    paint.yellow(paint.bold(`▌ Copilot asks (${body.request_id}): ${WHAT[body.tool_kind]}${where ? ` ${where}` : ""}`)) + ` · ${risk}`,
    paint.yellow("▌ ") + paint.bold(clean(permissionTarget(body))),
    paint.yellow("▌ ") + keys.join("   ") + paint.dim(`   (denied by itself in ${left} min)`),
  ];
}

// What a key press means while a request is shown. `a` only when the request offers it.
export function keyDecision(key: string, body: PermissionRequestBody): Decision | null {
  const k = key.toLowerCase();
  if (k === "y") {
    return "approve";
  }
  if (k === "a" && body.task_grant) {
    return "allow_task";
  }
  return k === "n" ? "deny" : null;
}

export const KEYS_HELP = "Keys: s stop the task · q close this view (the task keeps running)";
