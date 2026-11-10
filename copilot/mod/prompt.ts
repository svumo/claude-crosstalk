// A Copilot permission request as Claude Code's own question dialog: what Copilot wants to do, and
// buttons that answer it. The person's pick is written as a decision file (decided_by "button"),
// the same file /crosstalk-gh approve writes, so the sidecar's broker needs nothing new.
//
// One dialog at a time: requests that arrive while one is open wait their turn, and each is
// checked again before it is shown, so one already answered (by a typed command, a mode switch or
// the wait running out) never pops up.

import { taskPaths } from "../protocol/layout.ts";
import type { DecisionFile, ModeFile } from "../protocol/layout.ts";
import { permissionTarget } from "../protocol/render.ts";
import type { Decision, PermissionRequestBody } from "../protocol/schema.ts";
import type { Engine } from "./engine.ts";

const TARGET_CHARS = 200;

export const CHOICE = { approve: "Approve", allow: "Allow for task", deny: "Deny", bypass: "Bypass this task" } as const;

const WHAT: Record<PermissionRequestBody["tool_kind"], string> = {
  read: "read",
  write: "write",
  shell: "run",
  network: "fetch",
  other: "use",
};

// The dialog's question and buttons for one request. Pure.
export function permissionDialog(body: PermissionRequestBody): { question: string; header: string; options: string[] } {
  const target = permissionTarget(body).replace(/\s+/g, " ").trim();
  const shown = target.length > TARGET_CHARS ? `${target.slice(0, TARGET_CHARS - 1)}…` : target;
  const where = body.scope === "outside" ? " outside its worktree" : "";
  const question = `Copilot wants to ${WHAT[body.tool_kind]}${where}: ${shown} (${body.risk} risk). Allow it?`;
  const options = [CHOICE.approve, ...(body.task_grant ? [CHOICE.allow] : []), CHOICE.deny, CHOICE.bypass];
  return { question, header: `Copilot ${body.request_id}`.slice(0, 12), options };
}

// What a pick means: a decision for this request, and whether the task goes to bypass. Null for
// anything else (a dismissed dialog, free text that names no button).
export function readChoice(answer: string): { decision: Decision; bypass: boolean } | null {
  const said = answer.trim().toLowerCase();
  if (said === CHOICE.approve.toLowerCase() || said === "yes") {
    return { decision: "approve", bypass: false };
  }
  if (said === CHOICE.allow.toLowerCase()) {
    return { decision: "allow_task", bypass: false };
  }
  if (said === CHOICE.deny.toLowerCase() || said === "no") {
    return { decision: "deny", bypass: false };
  }
  if (said === CHOICE.bypass.toLowerCase()) {
    return { decision: "approve", bypass: true };
  }
  return null;
}

async function isWaiting($: Engine, root: string, body: PermissionRequestBody): Promise<boolean> {
  try {
    const state = JSON.parse(await $.fs.read(taskPaths(root, body.task_id).state)) as { pending?: unknown };
    return Array.isArray(state.pending) && state.pending.includes(body.request_id);
  } catch {
    return false;
  }
}

async function answer($: Engine, root: string, body: PermissionRequestBody): Promise<void> {
  if (!(await isWaiting($, root, body))) {
    return;
  }
  const { question, header, options } = permissionDialog(body);
  const picked = readChoice(await $.ui.ask(question, { header, options }).catch(() => ""));
  if (!picked) {
    $.ui.toast(`Copilot ${body.request_id} is still waiting: /crosstalk-gh approve ${body.request_id} or deny`);
    return;
  }
  if (!(await isWaiting($, root, body))) {
    return;
  }
  const paths = taskPaths(root, body.task_id);
  const at = await $.clock.now();
  if (picked.bypass) {
    const mode: ModeFile = { mode: "bypass", at };
    await $.fs.write(paths.mode, JSON.stringify(mode));
  }
  const decision: DecisionFile = { request_id: body.request_id, decision: picked.decision, decided_by: "button", at };
  await $.fs.write(`${paths.decisions}/${body.request_id}.json`, JSON.stringify(decision));
}

let queue: Promise<void> = Promise.resolve();

// Shows the request's dialog once those before it are answered. Returns at once.
export function askPermission($: Engine, root: string, body: PermissionRequestBody): Promise<void> {
  queue = queue.then(() => answer($, root, body)).catch(() => {});
  return queue;
}
