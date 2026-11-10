// The Copilot part of Crosstalk's hooks module: the /copilot command and what follows from it.
//
// hooks.json names a single module, and the engine takes one unmatched hook per event across that
// module and everything it imports. So hooks/crosstalk.mjs keeps the session's own hooks and calls
// in here: registerCopilot(on) adds the hooks that carry a matcher, and startCopilot($, host) runs
// from its session.start.

import { isDirty } from "../context/git.ts";
import { secretsIn } from "../context/minimise.ts";
import { taskId } from "../protocol/ids.ts";
import { taskPaths, tasksDir } from "../protocol/layout.ts";
import type { DecisionFile, TaskStateFile } from "../protocol/layout.ts";
import { parseQuota, QUOTA_ARGV, quotaLine } from "../protocol/quota.ts";
import type { Quota } from "../protocol/quota.ts";
import { makeEnvelope } from "../protocol/schema.ts";
import type { Decision, TaskBody } from "../protocol/schema.ts";
import { DEFAULT_CAPS } from "../sidecar/budget.ts";
import { HELP, isRunning, parseCopilot, pickTask, statusLine } from "./args.ts";
import { captureContext } from "./capture.ts";
import type { Who } from "./capture.ts";
import { isPerson } from "./engine.ts";
import type { Engine, On, Origin } from "./engine.ts";
import { blockBars, CLAUDE_LABEL, intoBand, isLive, PALETTE, pickShown, ringLine, ringPercent, ringSvg, taskPieces, UNAVAILABLE } from "./meter.ts";
import type { Piece } from "./meter.ts";

// What Crosstalk hands over at session start: its shared folder, and this session as it is now.
export type Host = { root: string; who: () => (Who & { address: string }) | null };

const NODE_NEEDED = [22, 18] as const;
const SHOWN_TASKS = 10;
const TOUCHED_MAX = 400;

let host: Host | null = null;
// Files this session edited, newest last, for the context a task carries.
let touched: string[] = [];

// The Copilot row above the prompt. Task files are read every TICK_MS; GitHub's meter every
// minute while a task runs, else every ten (build choice: often enough to see it move, rarely
// enough that an idle session barely calls GitHub).
const TICK_MS = 15_000;
const LIVE_QUOTA_MS = 60_000;
const IDLE_QUOTA_MS = 10 * 60_000;
let quota: Quota | null = null;
let quotaFailed = false;
let quotaAt = -Infinity;
let shown: TaskStateFile | null = null;
let tickedAt = 0;
// The ring's last number, and when it changed: it fills in for RING_FILL_MS after a change.
const RING_FILL_MS = 1_000;
let ringShown = -1;
let ringChangedAt = 0;

async function readQuota($: Engine): Promise<Quota | null> {
  const ran = await $.process.run([...QUOTA_ARGV], { timeoutMs: 15_000 }).catch(() => null);
  return ran && ran.exitCode === 0 ? parseQuota(ran.stdout) : null;
}

// Reads this session's tasks, and GitHub's meter when it is due (or `force`), then redraws.
async function tick($: Engine, force = false): Promise<void> {
  const me = host?.who() ?? null;
  if (!host || !me) {
    return;
  }
  const now = await $.clock.now();
  tickedAt = now;
  shown = pickShown(await readStates($, host.root, me.id), now);
  if (force || now - quotaAt >= (isLive(shown) ? LIVE_QUOTA_MS : IDLE_QUOTA_MS)) {
    quotaAt = now;
    const read = await readQuota($);
    if (read) {
      quota = read;
    }
    quotaFailed = read === null && quota === null;
  }
  $.ui.invalidate("ui.render");
}

function noteEdit(path: unknown): void {
  if (typeof path === "string" && path !== "") {
    touched = [...touched.filter((p) => p !== path), path].slice(-TOUCHED_MAX);
  }
}

export function registerCopilot(on: On): void {
  on("command.run", { command: "copilot" }, async ($, e) => ({ text: await copilotCommand($, String(e.args ?? ""), e.origin) }));

  on("tool.call", { tool: "Edit" }, async (_$, e, next) => {
    noteEdit(e.file_path);
    return next(e);
  });

  on("tool.call", { tool: "Write" }, async (_$, e, next) => {
    noteEdit(e.file_path);
    return next(e);
  });

  on("tool.call", { tool: "NotebookEdit" }, async (_$, e, next) => {
    noteEdit(e.notebook_path);
    return next(e);
  });

  // Stacks under whatever else draws above the prompt (the skins meters, token-ledger), so the
  // order mods load in does not matter.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const theirs = await next(e);
    if (e.props?.hasSurvey || (!quota && !quotaFailed && !shown)) {
      return e.surface === "terminal" ? blockBars(theirs) : theirs;
    }
    const ui = $.ui.resolve(e);
    const { Box, Text } = ui;
    const pieces = (list: Piece[]) => Box({
      flexDirection: "row", columnGap: 1, flexShrink: 0,
      children: list.map((p) => Text({ color: p.color, bold: p.bold === true, children: p.text })),
    });
    const mine: unknown[] = [];
    if (quota) {
      const percent = Math.round(ringPercent(quota));
      const now = await $.clock.now();
      if (percent !== ringShown) {
        ringShown = percent;
        ringChangedAt = now;
      }
      // Fills in when it first draws and when the number moves, like skins' rings; settled between.
      const animate = now - ringChangedAt < RING_FILL_MS;
      // The terminal draws Svg as nothing, so it gets skins' text meter there.
      if (e.surface !== "terminal" && ui.Svg) {
        const ring = ringSvg(percent, "copilot", animate);
        mine.push(ui.Svg({ key: "usage-copilot", source: ring.source, alt: ring.alt, width: ring.width, height: ring.height }));
      } else {
        const line = ringLine(percent, "copilot");
        mine.push(Text({ color: PALETTE.muted, children: [Text({ color: line.color, children: line.bar }), ` ${line.text}`] }));
      }
    } else if (quotaFailed) {
      mine.push(pieces([UNAVAILABLE]));
    }
    if (shown) {
      mine.push(pieces(taskPieces(shown, tickedAt, e.props?.bodyColumns ?? 80)));
    }
    // Among skins' context / 5h / 7d rings when its band is drawn; else a row of its own.
    // A `claude` label leads skins' rings, so the two accounts' meters read apart. In the
    // terminal skins' bars are redrawn in the same blocks as Copilot's.
    const base = e.surface === "terminal" ? blockBars(theirs) : theirs;
    const joined = intoBand(base, mine,[Text({ color: CLAUDE_LABEL, bold: true, children: "claude" })]);
    if (joined.joined) {
      return joined.node;
    }
    const row = Box({ paddingX: 1, flexDirection: "row", alignItems: "center", columnGap: 3, children: mine });
    return base ? Box({ flexDirection: "column", children: [base, row] }) : row;
  });
}

export async function startCopilot($: Engine, given: Host): Promise<void> {
  host = given;
  touched = [];
  await $.command.register({
    name: "copilot",
    description: "Hands a task to GitHub Copilot CLI in its own git worktree. status shows tasks; approve, allow and deny answer its requests; stop ends one.",
    argumentHint: "<task> | status | approve <request> | deny <request> | stop | setup",
  });
  quota = null;
  quotaFailed = false;
  quotaAt = -Infinity;
  shown = null;
  ringShown = -1;
  $.clock.every(TICK_MS, () => tick($).catch(() => {}));
  void tick($, true).catch(() => {});
}

async function readJson($: Engine, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path));
  } catch {
    return null;
  }
}

// This session's tasks, newest first.
async function readStates($: Engine, root: string, sessionId: string): Promise<TaskStateFile[]> {
  const entries = await $.fs.list(tasksDir(root)).catch(() => []);
  const states: TaskStateFile[] = [];
  for (const entry of entries.filter((e) => e.kind === "dir")) {
    const state = (await readJson($, taskPaths(root, entry.name).state)) as TaskStateFile | null;
    if (state && state.origin_id === sessionId && typeof state.started_at === "number" && Array.isArray(state.pending)) {
      states.push(state);
    }
  }
  return states.sort((a, b) => b.started_at - a.started_at);
}

async function nodeFault($: Engine): Promise<string> {
  const ran = await $.process.run(["node", "--version"], { timeoutMs: 15_000 }).catch(() => null);
  const match = /^v(\d+)\.(\d+)\./.exec(ran?.stdout.trim() ?? "");
  const need = `Copilot tasks run on Node.js ${NODE_NEEDED.join(".")} or newer`;
  if (!ran || ran.exitCode !== 0 || !match) {
    return `${need}, and \`node\` was not found. Install it from nodejs.org, then try again.`;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const isEnough = major > NODE_NEEDED[0] || (major === NODE_NEEDED[0] && minor >= NODE_NEEDED[1]);
  return isEnough ? "" : `${need}; this computer has ${ran.stdout.trim()}.`;
}

async function handOver($: Engine, root: string, me: Who & { address: string }, task: string): Promise<string> {
  const secrets = secretsIn(task);
  if (secrets.length > 0) {
    return `Not sent: the task holds what looks like ${secrets.join(" and ")}. Take it out and try again.`;
  }
  const fault = await nodeFault($);
  if (fault !== "") {
    return fault;
  }
  const captured = await captureContext($, me, touched);
  if (!captured.context) {
    return captured.error ?? "This session's context could not be read.";
  }
  const { context } = captured;
  const id = taskId(task, Math.random().toString(36).slice(2));
  const paths = taskPaths(root, id);
  const envelope = makeEnvelope<TaskBody>({
    id: `${id}-task`, thread_id: id, from: me.address, fromId: me.id, ...(me.title ? { fromTitle: me.title } : {}), to: `copilot/${id}`,
    sent_at: await $.clock.now(), kind: "task", body: { task_id: id, task }, text: `Task for Copilot: ${task}`,
    context: context as unknown as Record<string, unknown>, caps: DEFAULT_CAPS,
  });
  await $.fs.write(paths.task, JSON.stringify(envelope, null, 2));
  const started = await $.process.run(["node", `${$.plugin.root}/copilot/sidecar/main.ts`, "start", id, "--root", root], { timeoutMs: 30_000 }).catch(() => null);
  if (!started || started.exitCode !== 0) {
    return `Couldn't start the Copilot task${started?.stderr ? `: ${started.stderr.trim().slice(0, 300)}` : "."}`;
  }
  const dirty = context.git.dirty.staged + context.git.dirty.unstaged + context.git.dirty.untracked;
  const lines = [
    `Copilot task ${id} started, on branch copilot/${id} cut from ${context.git.branch || "this commit"} (${context.git.head_sha.slice(0, 12)}).`,
    "Copilot asks before it writes, runs a command or uses the network; its requests show here for you to answer. The result arrives as a Crosstalk message. /copilot status shows how it stands.",
  ];
  if (isDirty(context.git)) {
    lines.push(`Your uncommitted changes (${dirty} ${dirty === 1 ? "file" : "files"}) are not in its worktree, which is cut from the last commit.`);
  }
  return lines.join("\n");
}

async function decide($: Engine, root: string, sessionId: string, decision: Decision, requestId: string, named: string, origin: Origin): Promise<string> {
  if (!isPerson(origin)) {
    return "Only you can answer Copilot's requests: type the command yourself.";
  }
  const picked = pickTask(await readStates($, root, sessionId), named, (s) => s.pending.includes(requestId), `is waiting on ${requestId}`);
  if (!picked.state) {
    return picked.error ?? "";
  }
  if (!picked.state.pending.includes(requestId)) {
    return `${picked.state.task_id} is not waiting on ${requestId}. /copilot status shows what it is waiting on.`;
  }
  const answer: DecisionFile = { request_id: requestId, decision, decided_by: "command", at: await $.clock.now() };
  await $.fs.write(`${taskPaths(root, picked.state.task_id).decisions}/${requestId}.json`, JSON.stringify(answer));
  const said = { approve: "Approved", allow_task: "Allowed for the rest of the task", deny: "Denied" }[decision];
  return `${said}: ${requestId} of ${picked.state.task_id}.`;
}

async function stop($: Engine, root: string, sessionId: string, named: string): Promise<string> {
  const picked = pickTask(await readStates($, root, sessionId), named, isRunning, "is running");
  if (!picked.state) {
    return picked.error ?? "";
  }
  if (!isRunning(picked.state)) {
    return `${picked.state.task_id} has already ended (${picked.state.state}).`;
  }
  await $.fs.write(taskPaths(root, picked.state.task_id).stop, "stop\n");
  return `Stopping ${picked.state.task_id}. Its branch and worktree are kept; the reply says how to discard them.`;
}

// Installing software is the person's call, so only a command they typed runs it (build choice).
async function runSetup($: Engine, root: string, origin: Origin): Promise<string> {
  if (!isPerson(origin)) {
    return "Only you can run /copilot setup: type the command yourself.";
  }
  const fault = await nodeFault($);
  if (fault !== "") {
    return fault;
  }
  const ran = await $.process.run(["node", `${$.plugin.root}/copilot/sidecar/main.ts`, "setup", "--root", root], { timeoutMs: 300_000 }).catch(() => null);
  if (!ran) {
    return "Couldn't run Copilot setup.";
  }
  return (ran.stdout.trim() || ran.stderr.trim().slice(0, 600) || (ran.exitCode === 0 ? "Copilot setup finished." : "Copilot setup failed."));
}

async function copilotCommand($: Engine, args: string, origin: Origin): Promise<string> {
  const me = host?.who() ?? null;
  if (!host || !me) {
    return "Crosstalk did not start in this session.";
  }
  const command = parseCopilot(args);
  switch (command.verb) {
    case "help":
      return HELP;
    case "status": {
      const states = await readStates($, host.root, me.id);
      const now = await $.clock.now();
      const fresh = await readQuota($);
      if (fresh) {
        quota = fresh;
        quotaAt = now;
        quotaFailed = false;
      }
      const meter = fresh ? quotaLine(fresh) : "GitHub's Copilot meter could not be read (gh api copilot_internal/user failed; is gh signed in?).";
      const tasks = states.length === 0 ? "This session has handed Copilot no tasks. /copilot <task> starts one." : states.slice(0, SHOWN_TASKS).map((s) => statusLine(s, now)).join("\n");
      return `${tasks}\n${meter}`;
    }
    case "setup":
      return runSetup($, host.root, origin);
    case "decide":
      return decide($, host.root, me.id, command.decision, command.requestId, command.taskId, origin);
    case "stop":
      return stop($, host.root, me.id, command.taskId);
    case "task":
      return handOver($, host.root, me, command.task);
  }
}
