// What the sidecar needs from a Copilot backend, whichever one drives Copilot (ACP or the SDK).
// A backend never decides a permission: it hands each request to `onPermission` and waits.

import type { ToolKind } from "../protocol/schema.ts";

export type ToolStatus = "pending" | "running" | "done" | "failed";

export type FileDiff = { path: string; before: string | null; after: string };

export type BackendEvent =
  | { type: "message"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; id: string; kind: ToolKind; title: string; status: ToolStatus; command?: string; paths: string[]; diffs: FileDiff[] }
  | { type: "plan"; entries: string[] };

// One thing Copilot wants to do, as exactly as the backend can say it.
export type PermissionAsk = {
  toolId: string;
  kind: ToolKind;
  title: string;
  command?: string;
  paths: string[];
  url?: string;
};

export type PermissionAnswer = "allow" | "reject";

export type TokenUsage = { inputTokens: number; outputTokens: number; cachedTokens: number };

// "denied": the backend ended the turn itself because a permission request was refused (the SDK
// does this; ACP tells the model and carries on).
export type TurnResult = {
  stop: "end_turn" | "cancelled" | "denied" | "max_tokens" | "refusal" | "other";
  usage: TokenUsage;
};

export type TurnHandlers = {
  onEvent: (event: BackendEvent) => void;
  onPermission: (ask: PermissionAsk) => Promise<PermissionAnswer>;
};

export type StartOptions = {
  cwd: string;
  model?: string;
  // The child's whole environment: an allow-list, built by the sidecar.
  env: Record<string, string>;
};

// `account` is the GitHub login Copilot is signed in as, where the backend can say.
export type BackendInfo = { name: string; version: string; account?: string };

export interface CopilotBackend {
  start(options: StartOptions): Promise<BackendInfo>;
  prompt(text: string, handlers: TurnHandlers): Promise<TurnResult>;
  // Stops the turn in flight; its prompt() then resolves with stop "cancelled".
  cancel(): Promise<void>;
  // Ends the backend and its process. Safe to call twice.
  stop(): Promise<void>;
}

// The backend's process ended, or the connection to it broke, while it was needed.
export class BackendGone extends Error {
  override name = "BackendGone";
}

export const noUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
