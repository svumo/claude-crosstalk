// What the person typed after /copilot, and the lines the command answers with. Pure.

import { isTaskId } from "../protocol/ids.ts";
import { REQUEST_ID } from "../protocol/layout.ts";
import type { TaskStateFile } from "../protocol/layout.ts";
import { usageLine } from "../protocol/render.ts";
import { FINAL_STATES } from "../protocol/schema.ts";
import type { Decision } from "../protocol/schema.ts";

export type CopilotCommand =
  | { verb: "task"; task: string }
  | { verb: "status" }
  | { verb: "setup" }
  | { verb: "decide"; decision: Decision; requestId: string; taskId: string }
  | { verb: "stop"; taskId: string }
  | { verb: "help" };

const DECIDE: Record<string, Decision> = { approve: "approve", allow: "allow_task", deny: "deny" };

// A word is a command only in its exact shape; anything else is a task in the person's own words,
// so "/copilot stop the flaky test" hands over a task and "/copilot stop" stops one.
export function parseCopilot(args: string): CopilotCommand {
  const text = args.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const first = (words[0] ?? "").toLowerCase();
  if (text === "" || (first === "help" && words.length === 1)) {
    return { verb: "help" };
  }
  if (first === "status" && words.length === 1) {
    return { verb: "status" };
  }
  if (first === "setup" && words.length === 1) {
    return { verb: "setup" };
  }
  const taskId = words.length === 3 || (first === "stop" && words.length === 2) ? (words.at(-1) ?? "") : "";
  if (first === "stop" && words.length <= 2 && (taskId === "" || isTaskId(taskId))) {
    return { verb: "stop", taskId };
  }
  const decision = DECIDE[first];
  if (decision && (words.length === 2 || words.length === 3) && REQUEST_ID.test(words[1] ?? "") && (taskId === "" || isTaskId(taskId))) {
    return { verb: "decide", decision, requestId: words[1] ?? "", taskId };
  }
  return { verb: "task", task: text };
}

export const HELP = [
  "/copilot <task> hands the task to GitHub Copilot CLI in its own git worktree and branch. The result comes back here as a Crosstalk message.",
  "/copilot status shows this session's tasks and any request waiting for you.",
  "/copilot approve <request>, /copilot allow <request> (for the rest of the task) and /copilot deny <request> answer Copilot's requests. Only you can.",
  "/copilot stop [task] stops a task.",
  "/copilot setup installs the Copilot SDK that tasks run on, and checks who Copilot is signed in as. Without it, tasks run on Copilot CLI over ACP.",
].join("\n");

const age = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};

export const isRunning = (state: TaskStateFile): boolean => !FINAL_STATES.includes(state.state);

// One task as /copilot status shows it.
export function statusLine(state: TaskStateFile, now: number): string {
  const waiting = state.pending.length > 0 ? ` Waiting for you: ${state.pending.map((id) => `/copilot approve ${id}`).join(", ")}.` : "";
  const detail = state.detail && state.state !== "awaiting_approval" ? ` ${state.detail}` : "";
  return `${state.task_id}: ${state.state.replace("_", " ")}, started ${age(now - state.started_at)} ago, ${usageLine(state.usage)}.${detail}${waiting}`;
}

// Which task a command means: the one named, else the only one that fits. Returns { state } or { error }.
export function pickTask(states: TaskStateFile[], taskId: string, fits: (state: TaskStateFile) => boolean, what: string): { state?: TaskStateFile; error?: string } {
  const named = taskId === "" ? states.filter(fits) : states.filter((s) => s.task_id === taskId);
  if (named.length === 1) {
    return { state: named[0] };
  }
  if (named.length === 0) {
    return { error: taskId === "" ? `No task of this session ${what}. /copilot status shows them.` : `This session has no task ${taskId}. /copilot status shows them.` };
  }
  return { error: `More than one task ${what}: ${named.map((s) => s.task_id).join(", ")}. Add the task's name at the end.` };
}
