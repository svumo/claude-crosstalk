// What the person typed after /copilot, and the lines the command answers with. Pure.

import { isTaskId } from "../protocol/ids.ts";
import { REQUEST_ID } from "../protocol/layout.ts";
import type { TaskStateFile } from "../protocol/layout.ts";
import { usageLine } from "../protocol/render.ts";
import { FINAL_STATES, isMode, MODES } from "../protocol/schema.ts";
import type { Decision, Mode } from "../protocol/schema.ts";

export type CopilotCommand =
  | { verb: "task"; task: string; mode?: Mode; model?: string }
  | { verb: "status" }
  | { verb: "setup" }
  | { verb: "decide"; decision: Decision; requestId: string; taskId: string }
  | { verb: "stop"; taskId: string }
  | { verb: "mode"; mode: Mode | ""; taskId: string }
  | { verb: "models" }
  | { verb: "model"; model: string }
  | { verb: "error"; text: string }
  | { verb: "help" };

const DECIDE: Record<string, Decision> = { approve: "approve", allow: "allow_task", deny: "deny" };

// A model id as Copilot names them: `claude-sonnet-5.5`, `gpt-6.1-sol`, `auto`.
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// What each mode means, as the picker and the list say it.
export const MODE_TEXT: Record<Mode, string> = {
  ask: "asks you before every write, command and network call",
  auto: "approves reads and writes inside the task's worktree; asks before commands, network and anything outside",
  bypass: "approves everything without asking",
};

// Leading flags on a task: `--mode <m>` (or `--mode=<m>`), the shorthands `--bypass`, `--auto`
// and `--ask`, and `--model <id>`. Returns the flags and the task text after them, untouched.
function taskFlags(text: string): { mode?: Mode; model?: string; rest: string } | { error: string } {
  let rest = text;
  const found: { mode?: Mode; model?: string } = {};
  for (;;) {
    const match = /^--(model|mode|bypass|auto|ask)(?:[=\s]+(\S+))?(?:\s+|$)/i.exec(rest);
    if (!match) {
      return { ...found, rest };
    }
    const flag = (match[1] ?? "").toLowerCase();
    if (flag === "bypass" || flag === "auto" || flag === "ask") {
      found.mode = flag;
      rest = rest.slice(`--${flag}`.length).trimStart();
      continue;
    }
    const value = match[2] ?? "";
    if (flag === "mode") {
      if (!isMode(value.toLowerCase())) {
        return { error: `"${value}" isn't a Copilot mode. Choices: ${MODES.join(", ")}. /copilot mode lists them.` };
      }
      found.mode = value.toLowerCase() as Mode;
    } else {
      if (!MODEL_ID.test(value)) {
        return { error: `"${value}" isn't a model id. /copilot models lists them.` };
      }
      found.model = value;
    }
    rest = rest.slice(match[0].length);
  }
}

// A word is a command only in its exact shape; anything else is a task in the person's own words,
// so "/copilot stop the flaky test" hands over a task and "/copilot stop" stops one.
export function parseCopilot(args: string): CopilotCommand {
  const text = args.trim();
  if (text.startsWith("--")) {
    const flags = taskFlags(text);
    if ("error" in flags) {
      return { verb: "error", text: flags.error };
    }
    if (flags.rest.trim() === "") {
      return { verb: "error", text: "Say what the task is after the flags, such as /copilot --bypass add a README." };
    }
    return { verb: "task", task: flags.rest.trim(), ...(flags.mode ? { mode: flags.mode } : {}), ...(flags.model ? { model: flags.model } : {}) };
  }
  const words = text.split(/\s+/).filter(Boolean);
  const first = (words[0] ?? "").toLowerCase();
  if (text === "" || (first === "help" && words.length === 1)) {
    return { verb: "help" };
  }
  if (first === "mode" && words.length === 1) {
    return { verb: "mode", mode: "", taskId: "" };
  }
  const second = (words[1] ?? "").toLowerCase();
  if (first === "mode" && isMode(second) && (words.length === 2 || (words.length === 3 && isTaskId(words[2] ?? "")))) {
    return { verb: "mode", mode: second, taskId: words[2] ?? "" };
  }
  if ((first === "models" || first === "model") && words.length === 1) {
    return { verb: "models" };
  }
  if (first === "model" && words.length === 2 && MODEL_ID.test(words[1] ?? "")) {
    return { verb: "model", model: words[1] ?? "" };
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
  "/copilot --bypass <task> (or --auto, --mode <mode>, --model <id>) starts it in that mode or on that model.",
  "/copilot mode picks the mode new tasks start in; /copilot mode bypass [task] also switches this session's running tasks.",
  "/copilot models lists the models; /copilot model <id> picks the one new tasks use.",
  "/copilot status shows this session's tasks and any request waiting for you.",
  "Copilot's requests pop up for you to answer. /copilot approve <request>, /copilot allow <request> (for the rest of the task) and /copilot deny <request> answer them too. Only you can.",
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
  const mode = state.mode && state.mode !== "ask" ? ` (${state.mode})` : "";
  return `${state.task_id}${mode}: ${state.state.replace("_", " ")}, started ${age(now - state.started_at)} ago, ${usageLine(state.usage)}.${detail}${waiting}`;
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
