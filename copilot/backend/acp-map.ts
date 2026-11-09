// How Agent Client Protocol messages read as backend events and permission requests. Pure.
// Field names are the protocol's (agentclientprotocol.com); anything absent reads as empty.

import type { ToolKind } from "../protocol/schema.ts";
import type { BackendEvent, FileDiff, PermissionAsk, TokenUsage, ToolStatus, TurnResult } from "./adapter.ts";

type Bag = Record<string, unknown>;

const bag = (v: unknown): Bag => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Bag) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

const KINDS: Record<string, ToolKind> = {
  read: "read", search: "read",
  edit: "write", delete: "write", move: "write",
  execute: "shell",
  fetch: "network",
};

// A tool kind the protocol does not name is "other", which the policy treats as high-risk.
export const toolKind = (kind: unknown): ToolKind => KINDS[text(kind)] ?? "other";

const STATUS: Record<string, ToolStatus> = { pending: "pending", in_progress: "running", completed: "done", failed: "failed" };

function diffsOf(content: unknown): FileDiff[] {
  return list(content).map(bag).filter((c) => c.type === "diff" && text(c.path) !== "")
    .map((c) => ({ path: text(c.path), before: typeof c.oldText === "string" ? c.oldText : null, after: text(c.newText) }));
}

// The command a tool call would run. Copilot puts it in rawInput, as `command` or `commands`.
function commandOf(rawInput: Bag): string | undefined {
  const many = list(rawInput.commands).map(text).filter(Boolean);
  const one = text(rawInput.command) || many.join(" && ");
  return one === "" ? undefined : one;
}

function pathsOf(call: Bag, rawInput: Bag): string[] {
  const found = [
    ...list(call.locations).map((l) => text(bag(l).path)),
    ...diffsOf(call.content).map((d) => d.path),
    ...["path", "file_path", "filePath", "fileName"].map((key) => text(rawInput[key])),
  ].filter(Boolean);
  return [...new Set(found)];
}

function toolEvent(update: Bag): BackendEvent {
  const rawInput = bag(update.rawInput);
  const command = commandOf(rawInput);
  return {
    type: "tool",
    id: text(update.toolCallId),
    kind: toolKind(update.kind),
    title: text(update.title),
    status: STATUS[text(update.status)] ?? "pending",
    ...(command === undefined ? {} : { command }),
    paths: pathsOf(update, rawInput),
    diffs: diffsOf(update.content),
  };
}

// One `session/update` notification as an event, or null for the kinds the sidecar does not show.
export function eventOf(params: unknown): BackendEvent | null {
  const update = bag(bag(params).update);
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return { type: "message", text: text(bag(update.content).text) };
    case "agent_thought_chunk":
      return { type: "thought", text: text(bag(update.content).text) };
    case "tool_call":
    case "tool_call_update":
      return toolEvent(update);
    case "plan":
      return { type: "plan", entries: list(update.entries).map((e) => text(bag(e).content)).filter(Boolean) };
    default:
      return null;
  }
}

export type AcpOption = { optionId: string; kind: string };

export function askOf(params: unknown): { ask: PermissionAsk; options: AcpOption[] } {
  const p = bag(params);
  const call = bag(p.toolCall);
  const rawInput = bag(call.rawInput);
  const command = commandOf(rawInput);
  const url = text(rawInput.url);
  return {
    ask: {
      toolId: text(call.toolCallId),
      kind: toolKind(call.kind),
      title: text(call.title),
      ...(command === undefined ? {} : { command }),
      paths: pathsOf(call, rawInput),
      ...(url === "" ? {} : { url }),
    },
    options: list(p.options).map(bag).map((o) => ({ optionId: text(o.optionId), kind: text(o.kind) })).filter((o) => o.optionId !== ""),
  };
}

// The reply to a permission request. Copilot is only ever told "once": what a task grant covers is
// the sidecar's to remember, so Copilot asks again and the broker answers from the grant.
export function outcomeFor(answer: "allow" | "reject", options: AcpOption[]): Bag {
  const wanted = answer === "allow" ? "allow_once" : "reject_once";
  const option = options.find((o) => o.kind === wanted);
  return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
}

export function usageOf(result: Bag): TokenUsage {
  const usage = bag(result.usage);
  return {
    inputTokens: count(usage.inputTokens ?? usage.input_tokens),
    outputTokens: count(usage.outputTokens ?? usage.output_tokens),
    cachedTokens: count(usage.cachedReadTokens ?? usage.cachedTokens ?? usage.cached_tokens),
  };
}

const STOPS: Record<string, TurnResult["stop"]> = { end_turn: "end_turn", cancelled: "cancelled", max_tokens: "max_tokens", refusal: "refusal" };

export function turnOf(result: unknown): TurnResult {
  const r = bag(result);
  return { stop: STOPS[text(r.stopReason)] ?? "other", usage: usageOf(r) };
}
