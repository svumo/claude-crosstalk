// Where Copilot tasks keep their files under Crosstalk's shared folder. Pure path arithmetic,
// with forward slashes, so the mod and the sidecar agree.
//
//   <root>/copilot/tasks/<task id>/task.json            the task as handed over (a v1 envelope)
//   <root>/copilot/tasks/<task id>/state.json           where the task stands now
//   <root>/copilot/tasks/<task id>/events/<seq>.json    what Copilot did, one file an event
//   <root>/copilot/tasks/<task id>/requests/<id>.json   a permission request waiting for the person
//   <root>/copilot/tasks/<task id>/decisions/<id>.json  the person's answer to it
//   <root>/copilot/tasks/<task id>/stop                 asks the sidecar to stop
//   <root>/copilot/tasks/<task id>/sidecar.log          the sidecar's own log
//   <root>/copilot/audit/<yyyy-mm-dd>.jsonl             every task, request and decision

import type { Decision, Decider, TaskState, Usage } from "./schema.ts";

const tidy = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

export type TaskPaths = {
  dir: string;
  task: string;
  state: string;
  events: string;
  requests: string;
  decisions: string;
  stop: string;
  log: string;
};

export function taskPaths(root: string, taskId: string): TaskPaths {
  const dir = `${tidy(root)}/copilot/tasks/${taskId}`;
  return {
    dir,
    task: `${dir}/task.json`,
    state: `${dir}/state.json`,
    events: `${dir}/events`,
    requests: `${dir}/requests`,
    decisions: `${dir}/decisions`,
    stop: `${dir}/stop`,
    log: `${dir}/sidecar.log`,
  };
}

export const tasksDir = (root: string): string => `${tidy(root)}/copilot/tasks`;
export const auditFile = (root: string, day: string): string => `${tidy(root)}/copilot/audit/${day}.jsonl`;
export const eventName = (seq: number): string => `${String(seq).padStart(8, "0")}.json`;

// What state.json holds: enough for /copilot status and the status line, with no reading of events.
export type TaskStateFile = {
  task_id: string;
  state: TaskState;
  detail: string;
  task: string;
  origin_id: string;
  origin_address: string;
  branch: string;
  worktree: string;
  backend: string;
  model: string;
  usage: Usage;
  pending: string[];
  started_at: number;
  updated_at: number;
  pid: number;
};

// What a decision file holds. Only the person's own acts write one.
export type DecisionFile = { request_id: string; decision: Decision; decided_by: Decider; at: number };

export const REQUEST_ID = /^[a-z0-9]{1,12}$/;
