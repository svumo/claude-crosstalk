// One turn of Copilot's: a prompt in, its events written down, its requests brokered, and an end
// that is one of five things. A turn is watched the whole way: for a tool that ran unapproved,
// for the person's stop, and for the clock.

import { BackendGone } from "../backend/adapter.ts";
import type { BackendEvent, CopilotBackend, TurnResult } from "../backend/adapter.ts";
import { isInside } from "../context/git.ts";
import type { Broker } from "./broker.ts";
import { resolveReal } from "./files.ts";
import type { EventLog, Log } from "./record.ts";
import type { Tripwire } from "./tripwire.ts";
import type { Mode } from "../protocol/schema.ts";

export type TurnEnd =
  | { kind: "done"; result: TurnResult; said: string }
  | { kind: "stopped"; said: string }
  | { kind: "timeout"; said: string }
  | { kind: "breach"; detail: string; said: string }
  | { kind: "gone"; detail: string; ranTool: boolean; said: string };

export type TurnDeps = {
  backend: CopilotBackend;
  events: EventLog;
  broker: Broker;
  tripwire: Tripwire;
  worktree: string;
  timeoutMs: number;
  shouldStop: () => boolean;
  log: Log;
  // The task's permission mode now. In bypass a tool that ran without asking is written down, not
  // a breach: the person already approved everything, so there was nothing to ask.
  mode?: () => Mode;
};

const WATCH_MS = 250;
const CANCEL_GRACE_MS = 5_000;
const DIFF_CHARS = 20_000;
const cut = (text: string | null): string | null => (text === null || text.length <= DIFF_CHARS ? text : `${text.slice(0, DIFF_CHARS)}\n… (cut)`);

export async function runTurn(prompt: string, deps: TurnDeps): Promise<TurnEnd> {
  const { backend, events, broker, tripwire, worktree, log } = deps;
  const deadline = Date.now() + deps.timeoutMs;
  let said = "";
  let breach = "";
  let ranTool = false;
  let why: "stopped" | "timeout" | "" = "";

  const end = (reason: "stopped" | "timeout"): void => {
    if (why === "") {
      why = reason;
      broker.close();
      void backend.cancel().catch(() => {});
      // A backend that does not answer the cancel is ended, which ends its turn.
      setTimeout(() => void backend.stop().catch(() => {}), CANCEL_GRACE_MS).unref();
    }
  };

  const onEvent = (event: BackendEvent): void => {
    if (event.type === "message" || event.type === "thought") {
      events.text(event.type, event.text);
      said += event.type === "message" ? event.text : "";
      return;
    }
    if (event.type === "plan") {
      events.add("plan", undefined, { entries: event.entries });
      return;
    }
    ranTool = ranTool || event.status === "running" || event.status === "done";
    const isOutside = event.paths.some((path) => !isInside(resolveReal(path, worktree), worktree));
    events.add("tool", event.title, {
      id: event.id, kind: event.kind, status: event.status, command: event.command ?? null, paths: event.paths,
      diffs: event.diffs.map((d) => ({ path: d.path, before: cut(d.before), after: cut(d.after) })),
    });
    const problem = tripwire.check(event, isOutside);
    if (problem !== "" && deps.mode?.() === "bypass") {
      log("warn", "unasked", { tool: event.id, kind: event.kind, command: event.command ?? null });
      events.add("permission", `ran without asking (bypass): ${event.command ?? event.title}`, { id: event.id });
      return;
    }
    if (problem !== "" && breach === "") {
      breach = problem;
      log("error", "tripwire", { tool: event.id, kind: event.kind });
      broker.close();
      void backend.stop().catch(() => {}); // not a cancel: the backend is no longer trusted
    }
  };

  const watch = setInterval(() => {
    if (deps.shouldStop()) {
      end("stopped");
    } else if (Date.now() > deadline) {
      end("timeout");
    }
  }, WATCH_MS);

  try {
    const result = await backend.prompt(prompt, { onEvent, onPermission: (ask) => broker.decide(ask) });
    if (breach !== "") {
      return { kind: "breach", detail: breach, said };
    }
    return why === "" ? { kind: "done", result, said } : { kind: why, said };
  } catch (error) {
    if (breach !== "") {
      return { kind: "breach", detail: breach, said };
    }
    if (why !== "") {
      return { kind: why, said };
    }
    // The backend ended, or reported an error of its own: either way the turn is over.
    const detail = error instanceof Error ? error.message : String(error);
    log(error instanceof BackendGone ? "warn" : "error", "turn-failed", { detail_chars: detail.length });
    return { kind: "gone", detail, ranTool, said };
  } finally {
    clearInterval(watch);
    events.flush();
  }
}
