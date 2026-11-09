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
import { makeEnvelope } from "../protocol/schema.ts";
import type { Decision, TaskBody } from "../protocol/schema.ts";
import { DEFAULT_CAPS } from "../sidecar/budget.ts";
import { HELP, isRunning, parseCopilot, pickTask, statusLine } from "./args.ts";
import { captureContext } from "./capture.ts";
import type { Who } from "./capture.ts";
import { isPerson } from "./engine.ts";
import type { Engine, On, Origin } from "./engine.ts";

// What Crosstalk hands over at session start: its shared folder, and this session as it is now.
export type Host = { root: string; who: () => (Who & { address: string }) | null };

const NODE_NEEDED = [22, 18] as const;
const SHOWN_TASKS = 10;
const TOUCHED_MAX = 400;

let host: Host | null = null;
// Files this session edited, newest last, for the context a task carries.
let touched: string[] = [];

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
}

export async function startCopilot($: Engine, given: Host): Promise<void> {
  host = given;
  touched = [];
  await $.command.register({
    name: "copilot",
    description: "Hands a task to GitHub Copilot CLI in its own git worktree. status shows tasks; approve, allow and deny answer its requests; stop ends one.",
    argumentHint: "<task> | status | approve <request> | deny <request> | stop",
  });
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
      return states.length === 0 ? "This session has handed Copilot no tasks. /copilot <task> starts one." : states.slice(0, SHOWN_TASKS).map((s) => statusLine(s, now)).join("\n");
    }
    case "decide":
      return decide($, host.root, me.id, command.decision, command.requestId, command.taskId, origin);
    case "stop":
      return stop($, host.root, me.id, command.taskId);
    case "task":
      return handOver($, host.root, me, command.task);
  }
}
