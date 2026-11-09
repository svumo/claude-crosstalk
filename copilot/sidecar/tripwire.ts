// The tripwire: notices a tool that ran without an approval. Pure.
//
// A backend's permission channel can fail open (Copilot CLI 1.0.81 to 1.0.104 sent no requests at
// all). So every tool call the backend reports is checked against the approvals the broker
// recorded, and a gated one with none is a breach: the task is stopped and the person told.

import type { BackendEvent } from "../backend/adapter.ts";
import { GATED } from "./policy.ts";

export class Tripwire {
  private readonly approved = new Set<string>();

  // Called by the broker when the person (or a grant of theirs) allowed this tool call.
  approve(toolId: string): void {
    this.approved.add(toolId);
  }

  // Returns what went wrong, or "" when the event is in order. `isOutside` says whether the
  // tool's paths, resolved, leave the worktree: a read is gated only then.
  check(event: BackendEvent, isOutside: boolean): string {
    if (event.type !== "tool" || (event.status !== "running" && event.status !== "done")) {
      return "";
    }
    const isGated = GATED.includes(event.kind) || (event.kind === "read" && isOutside);
    if (!isGated || this.approved.has(event.id)) {
      return "";
    }
    const what = event.command ?? (event.paths.join(", ") || event.title || event.kind);
    return `Copilot ${event.kind === "read" ? "read outside its worktree" : `ran a ${event.kind} tool`} with no approval: ${what}`;
  }
}
