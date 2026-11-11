// The permission broker. Every request Copilot makes stops here until the person answers it, a
// grant they gave earlier in this task covers it, or the wait runs out, which denies it.
//
// An answer is a file in the task's decisions folder, written by the person's own act: a key in
// the attach terminal, a /crosstalk-gh command they typed, or a button they pressed. Nothing a model
// can call writes one.

import type { PermissionAnswer, PermissionAsk } from "../backend/adapter.ts";
import type { DecisionFile, TaskPaths } from "../protocol/layout.ts";
import { DECISIONS } from "../protocol/schema.ts";
import type { Decider, Decision, PermissionRequestBody } from "../protocol/schema.ts";
import { readJson, remove, resolveReal, writeJson } from "./files.ts";
import type { Mode } from "../protocol/schema.ts";
import { autoApproves, classify, isCovered } from "./policy.ts";
import type { Grant } from "./policy.ts";
import type { Audit } from "./record.ts";
import type { Tripwire } from "./tripwire.ts";

const POLL_MS = 250;
// Who may decide through a file. "timeout" and "policy" are the broker's own, never read from one.
const PERSON: readonly Decider[] = ["terminal", "command", "button"];

export type BrokerOptions = {
  taskId: string;
  paths: TaskPaths;
  worktree: string;
  timeoutMs: number;
  tripwire: Tripwire;
  audit: Audit;
  // The task's permission mode now; read on each request and while one waits, as the person may
  // switch it mid-task. Absent: "ask".
  mode?: () => Mode;
  // Tells the person a request is waiting (the originating session's inbox, the event log).
  onRequest: (request: PermissionRequestBody) => void;
  onSettled: (request: PermissionRequestBody, decision: Decision, by: Decider) => void;
};

function readDecision(path: string, requestId: string): DecisionFile | null {
  const value = readJson(path);
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const file = value as Partial<DecisionFile>;
  const isValid = file.request_id === requestId && DECISIONS.includes(file.decision as Decision) && PERSON.includes(file.decided_by as Decider);
  return isValid ? (file as DecisionFile) : null;
}

export class Broker {
  private readonly grants: Grant[] = [];
  private readonly open = new Set<string>();
  private count = 0;
  private isClosed = false;
  private readonly options: BrokerOptions;

  constructor(options: BrokerOptions) {
    this.options = options;
  }

  private mode(): Mode {
    return this.options.mode?.() ?? "ask";
  }

  get pending(): string[] {
    return [...this.open];
  }

  // Stops waiting: every open request, and any that follows, is denied.
  close(): void {
    this.isClosed = true;
  }

  async decide(ask: PermissionAsk): Promise<PermissionAnswer> {
    const { paths, worktree, taskId, audit } = this.options;
    const resolved = ask.paths.map((p) => resolveReal(p, worktree));
    const classified = classify(ask, resolved, worktree);
    const { grant, ...shown } = classified;
    this.count += 1;
    const request: PermissionRequestBody = { task_id: taskId, request_id: `r${this.count}`, ...shown, expires_at: Date.now() + this.options.timeoutMs };
    audit("request", { ...request });
    if (isCovered(this.grants, classified) || autoApproves(this.mode(), classified)) {
      return this.settle(request, ask, "approve", "policy");
    }
    if (this.isClosed) {
      return this.settle(request, ask, "deny", "policy");
    }
    const requestFile = `${paths.requests}/${request.request_id}.json`;
    const decisionFile = `${paths.decisions}/${request.request_id}.json`;
    writeJson(requestFile, request);
    this.open.add(request.request_id);
    this.options.onRequest(request);
    let decision: Decision = "deny";
    let by: Decider = "timeout";
    while (Date.now() < request.expires_at && !this.isClosed) {
      const answer = readDecision(decisionFile, request.request_id);
      if (answer) {
        decision = answer.decision;
        by = answer.decided_by;
        break;
      }
      // The person switched the task's mode while this request waited.
      if (autoApproves(this.mode(), classified)) {
        decision = "approve";
        by = "policy";
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    this.open.delete(request.request_id);
    remove(requestFile);
    if (decision === "allow_task" && grant) {
      this.grants.push(grant);
    }
    return this.settle(request, ask, decision, by);
  }

  private settle(request: PermissionRequestBody, ask: PermissionAsk, decision: Decision, by: Decider): PermissionAnswer {
    this.options.audit("decision", { request_id: request.request_id, decision, decided_by: by });
    this.options.onSettled(request, decision, by);
    if (decision === "deny") {
      return "reject";
    }
    this.options.tripwire.approve(ask.toolId);
    return "allow";
  }
}
