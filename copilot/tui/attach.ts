// The attach viewer: a terminal that shows one Copilot task live and answers its requests.
//
//   node copilot/tui/attach.ts <task id> [--root <Crosstalk's folder>] [--no-color]
//
// It reads the task's files the sidecar writes (state.json, events/, requests/) and writes only
// two kinds: a decision for a request, from a key the person pressed here (decided_by
// "terminal"), and the stop file. Closing it leaves the task running.

import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { isTaskId } from "../protocol/ids.ts";
import { REQUEST_ID, taskPaths } from "../protocol/layout.ts";
import type { DecisionFile, TaskStateFile } from "../protocol/layout.ts";
import { FINAL_STATES } from "../protocol/schema.ts";
import type { Decision, EventBody, PermissionRequestBody } from "../protocol/schema.ts";
import { listNames, readJson, writeJson, writeWhole } from "../sidecar/files.ts";
import { COLOR, headerLines, KEYS_HELP, keyDecision, newMemory, PLAIN, renderEvent, requestCard, usageText } from "./view.ts";

const POLL_MS = 250;
const MISSING_GIVE_UP_MS = 15_000;
const EVENT_FILE = /^\d{8}\.json$/;

function argsOf(argv: string[]): { taskId: string; root: string; color: boolean } | null {
  const [taskId, ...rest] = argv;
  if (!isTaskId(taskId)) {
    return null;
  }
  const at = rest.indexOf("--root");
  const root = (at >= 0 ? rest[at + 1] : undefined) ?? process.env.CLAUDE_CROSSTALK_DIR ?? `${homedir()}/.claude-crosstalk`;
  const color = !rest.includes("--no-color") && process.stdout.isTTY === true && !process.env.NO_COLOR;
  return { taskId, root: root.replace(/\\/g, "/").replace(/\/+$/, ""), color };
}

const DONE: Record<Decision, string> = { approve: "Approved", allow_task: "Allowed for the rest of the task", deny: "Denied" };

export async function attach(taskId: string, root: string, color: boolean): Promise<number> {
  const paint = color ? COLOR : PLAIN;
  const paths = taskPaths(root, taskId);
  const memory = newMemory();
  const say = (lines: string[]): void => {
    if (lines.length > 0) {
      process.stdout.write(`${lines.join("\n")}\n`);
    }
  };
  let lastEvent = "";
  let state: TaskStateFile | null = null;
  let headed = false;
  let shown: PermissionRequestBody | null = null;
  let askingStop = false;
  let closing = false;
  const startedAt = Date.now();

  const close = (code: number): void => {
    closing = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.exitCode = code;
  };

  const answer = (decision: Decision): void => {
    const request = shown;
    if (!request) {
      return;
    }
    shown = null;
    // Answered elsewhere already (the pop-up, a command): the request file is gone.
    if (!existsSync(`${paths.requests}/${request.request_id}.json`)) {
      say([paint.dim(`${request.request_id} was already answered.`)]);
      return;
    }
    const file: DecisionFile = { request_id: request.request_id, decision, decided_by: "terminal", at: Date.now() };
    writeJson(`${paths.decisions}/${request.request_id}.json`, file);
    say([(decision === "deny" ? paint.red : paint.green)(`${DONE[decision]}: ${request.request_id}.`)]);
  };

  const onKey = (key: string): void => {
    if (key === "\u0003" || (!shown && !askingStop && key.toLowerCase() === "q")) {
      say([paint.dim("Closed the view. The task keeps running; /crosstalk-gh open shows it again.")]);
      close(0);
      return;
    }
    if (askingStop) {
      askingStop = false;
      if (key.toLowerCase() === "y") {
        writeWhole(paths.stop, "stop\n");
        say([paint.yellow("Stopping the task. Its branch and worktree are kept.")]);
      } else {
        say([paint.dim("Not stopped.")]);
      }
      return;
    }
    if (shown) {
      const decision = keyDecision(key, shown);
      if (decision) {
        answer(decision);
      }
      return;
    }
    if (key.toLowerCase() === "s" && state && !FINAL_STATES.includes(state.state)) {
      askingStop = true;
      say([paint.yellow("Stop the task? y / n")]);
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const key of chunk) {
      if (!closing && key !== "\n" && key !== "\r") {
        onKey(key);
      }
    }
  });
  process.stdin.on("error", () => {});

  while (!closing) {
    const read = readJson(paths.state);
    state = typeof read === "object" && read !== null && typeof (read as TaskStateFile).task_id === "string" ? (read as TaskStateFile) : state;
    if (!headed && (state || existsSync(paths.dir))) {
      headed = true;
      say([...headerLines(state, taskId, paint), paint.dim(KEYS_HELP)]);
    }
    if (!headed && Date.now() - startedAt > MISSING_GIVE_UP_MS) {
      say([`There is no Copilot task ${taskId} under ${root}.`]);
      close(1);
      break;
    }

    const fresh = listNames(paths.events).filter((n) => EVENT_FILE.test(n) && n > lastEvent);
    for (const name of fresh) {
      const event = readJson(`${paths.events}/${name}`) as EventBody | null;
      if (!event || typeof event.type !== "string") {
        break; // not whole yet: read again next time
      }
      lastEvent = name;
      say(renderEvent(event, memory, paint));
    }

    // The oldest request still waiting, drawn once; one gone from the folder was answered.
    const waiting = listNames(paths.requests).filter((n) => REQUEST_ID.test(n.replace(/\.json$/, "")) && n.endsWith(".json"));
    if (shown && !waiting.includes(`${shown.request_id}.json`)) {
      shown = null;
    }
    if (!shown && !askingStop && waiting.length > 0) {
      const first = waiting.sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)))[0] as string;
      const body = readJson(`${paths.requests}/${first}`) as PermissionRequestBody | null;
      if (body && typeof body.request_id === "string") {
        shown = body;
        memory.last = "";
        say(requestCard(body, Date.now(), paint));
      }
    }

    if (state && FINAL_STATES.includes(state.state) && fresh.length === 0) {
      say(["", paint.bold(`Task ${state.state}.`) + paint.dim(` Used ${usageText(state)}.`), paint.dim("The reply is in the session that started it.")]);
      close(state.state === "completed" ? 0 : 1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return process.exitCode === undefined ? 0 : Number(process.exitCode);
}

const given = argsOf(process.argv.slice(2));
if (!given) {
  process.stderr.write("Usage: attach.ts <task id> [--root <folder>] [--no-color]\n");
  process.exitCode = 2;
} else {
  // Exits outright: a paused terminal stdin can still hold the process open on some systems.
  attach(given.taskId, given.root, given.color).then((code) => process.exit(code), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
