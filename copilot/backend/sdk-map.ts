// How the Copilot SDK's permission requests and session events read as the sidecar's own. Pure.
// Field names are @github/copilot-sdk 1.0.30's (dist/generated/session-events.d.ts); anything
// absent reads as empty.

import type { ToolKind } from "../protocol/schema.ts";
import type { BackendEvent, PermissionAsk, TokenUsage } from "./adapter.ts";

type Bag = Record<string, unknown>;

const bag = (v: unknown): Bag => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Bag) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

// The SDK's request kinds that have a counterpart here. Every other kind (an MCP tool, memory, a
// custom tool, a hook, an extension) is "other", which the policy treats as high-risk.
const KINDS: Record<string, ToolKind> = { shell: "shell", write: "write", read: "read", url: "network" };

// One permission request as the broker's question. A shell request carries the whole command
// line and the paths it may touch; a file request its path, resolved where the SDK resolved it.
export function askOf(request: unknown): PermissionAsk {
  const r = bag(request);
  const kind = KINDS[text(r.kind)] ?? "other";
  const base = { toolId: text(r.toolCallId), kind, title: text(r.intention) || text(r.kind) };
  switch (kind) {
    case "shell":
      return { ...base, command: text(r.fullCommandText), paths: texts(r.possiblePaths) };
    case "write":
      return { ...base, paths: [text(r.resolvedPath) || text(r.fileName)].filter(Boolean) };
    case "read":
      return { ...base, paths: [text(r.resolvedPath) || text(r.path)].filter(Boolean) };
    case "network":
      return { ...base, paths: [], url: text(r.url) };
    case "other":
      return { ...base, paths: [] };
  }
}

// The answer in the SDK's words. Only ever "once": what a task grant covers is the sidecar's to
// remember, so Copilot asks again and the broker answers from the grant.
export function resultFor(answer: "allow" | "reject"): { kind: "approve-once" } | { kind: "reject" } {
  return answer === "allow" ? { kind: "approve-once" } : { kind: "reject" };
}

export type ToolEvent = Extract<BackendEvent, { type: "tool" }>;

// What a tool call is, when no permission request named it. A call the SDK marks read-only is a
// read. One with shell details is a shell call. Any other is "other", so the tripwire asks for an
// approval on record before it lets the call by.
function unaskedKind(data: Bag): ToolKind {
  if (data.shellToolInfo !== undefined) {
    return "shell";
  }
  return data.readOnly === true ? "read" : "other";
}

// A tool starting or ending, as a tool event. `asked` holds the requests the person was put, by
// tool call id, so the event carries the same kind, command and paths the request did.
export function toolOf(type: string, data: unknown, asked: Map<string, PermissionAsk>, known: Map<string, ToolEvent>): ToolEvent {
  const d = bag(data);
  const id = text(d.toolCallId);
  const ask = asked.get(id);
  const before = known.get(id);
  const isStart = type === "tool.execution_start";
  const event: ToolEvent = {
    type: "tool",
    id,
    kind: ask?.kind ?? before?.kind ?? unaskedKind(d),
    title: text(d.toolTitle) || text(d.toolName) || (before?.title ?? ""),
    status: isStart ? "running" : d.success === true ? "done" : "failed",
    ...(ask?.command ? { command: ask.command } : before?.command ? { command: before.command } : {}),
    paths: ask?.paths ?? before?.paths ?? [],
    diffs: [],
  };
  known.set(id, event);
  return event;
}

export function usageOf(data: unknown): TokenUsage {
  const d = bag(data);
  return { inputTokens: count(d.inputTokens), outputTokens: count(d.outputTokens), cachedTokens: count(d.cacheReadTokens) };
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
});
