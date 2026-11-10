// Crosstalk message schema, version 1. Pure, so the mod and the sidecar both use it.
//
// A v1 message is also a valid v0 message: it keeps `from`, `fromId`, `to`, `sentAt` and `text`,
// which is all today's Claude peers read. docs/protocol.md describes it for other adapters.

export const SCHEMA_VERSION = 1;

export const KINDS = ["task", "reply", "status", "event", "permission_request", "permission_decision"] as const;
export type Kind = (typeof KINDS)[number];

// What a task may still do by itself: replies in a row, and what it may spend.
export type Caps = {
  hops: number;
  wake_limit: number;
  credit_budget: number;
  max_prompts: number;
};

export const TASK_STATES = ["starting", "working", "awaiting_approval", "idle", "completed", "failed", "cancelled", "refused"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const FINAL_STATES: readonly TaskState[] = ["completed", "failed", "cancelled", "refused"];

export const TOOL_KINDS = ["read", "write", "shell", "network", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const DECISIONS = ["approve", "allow_task", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECIDERS = ["terminal", "command", "button", "timeout", "policy"] as const;
export type Decider = (typeof DECIDERS)[number];

export type Usage = {
  prompts: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  // AI credits, when the model's price is known; null when it is not.
  credits: number | null;
};

export type TaskBody = { task_id: string; task: string; model?: string };

export type ReplyBody = {
  task_id: string;
  outcome: "completed" | "failed" | "cancelled" | "refused";
  summary: string;
  diff_stat: string;
  branch: string;
  worktree: string;
  base_sha: string;
  commands: { review: string; merge: string; discard: string };
  usage: Usage;
  // How GitHub's account meter moved while the task ran, in words; absent when it could not be read.
  meter?: string;
};

export type StatusBody = { task_id: string; state: TaskState; detail?: string };

export type EventBody = {
  task_id: string;
  seq: number;
  type: "message" | "thought" | "tool" | "plan" | "usage" | "state" | "permission" | "log";
  text?: string;
  data?: Record<string, unknown>;
};

export type PermissionRequestBody = {
  task_id: string;
  request_id: string;
  tool_kind: ToolKind;
  title: string;
  // Exactly what would run or be touched, from the request's raw input.
  command?: string;
  paths?: string[];
  url?: string;
  scope: "worktree" | "outside" | "none";
  risk: "low" | "high";
  // What "allow for this task" would cover, or null when it is not offered.
  task_grant: string | null;
  expires_at: number;
};

export type PermissionDecisionBody = {
  task_id: string;
  request_id: string;
  decision: Decision;
  decided_by: Decider;
};

export type Body = TaskBody | ReplyBody | StatusBody | EventBody | PermissionRequestBody | PermissionDecisionBody;

export type Signature = { alg: "HMAC-SHA256"; key_id: string; mac: string };

export type Envelope<B extends Body = Body> = {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  thread_id: string;
  reply_to?: string;
  from: string;
  to: string;
  sent_at: number;
  kind: Kind;
  body: B;
  context?: Record<string, unknown>;
  caps?: Caps;
  sig?: Signature;
  // The v0 fields.
  fromId: string;
  fromTitle?: string;
  sentAt: number;
  text: string;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

// Whether a body has what its kind needs. Returns the first thing missing, or "".
function bodyFault(kind: Kind, body: Record<string, unknown>): string {
  if (!isText(body.task_id)) {
    return "body.task_id";
  }
  switch (kind) {
    case "task":
      return isText(body.task) ? "" : "body.task";
    case "reply":
      return oneOf(FINAL_STATES, body.outcome) && typeof body.summary === "string" && isObject(body.commands) && isObject(body.usage) ? "" : "body (reply)";
    case "status":
      return oneOf(TASK_STATES, body.state) ? "" : "body.state";
    case "event":
      return isCount(body.seq) && isText(body.type) ? "" : "body (event)";
    case "permission_request":
      return isText(body.request_id) && oneOf(TOOL_KINDS, body.tool_kind) && isCount(body.expires_at) ? "" : "body (permission_request)";
    case "permission_decision":
      return isText(body.request_id) && oneOf(DECISIONS, body.decision) && oneOf(DECIDERS, body.decided_by) ? "" : "body (permission_decision)";
  }
}

// Reads anything as a v1 envelope. A v0 message (no schema_version) is not one: see fromV0.
export function parseEnvelope(value: unknown): Parsed<Envelope> {
  if (!isObject(value)) {
    return bad("not an object");
  }
  if (value.schema_version !== SCHEMA_VERSION) {
    return bad(`schema_version is ${JSON.stringify(value.schema_version)}, not ${SCHEMA_VERSION}`);
  }
  for (const key of ["id", "thread_id", "from", "to", "fromId"] as const) {
    if (!isText(value[key])) {
      return bad(`${key} is missing`);
    }
  }
  if (!isCount(value.sent_at) || !isCount(value.sentAt) || typeof value.text !== "string") {
    return bad("sent_at, sentAt or text is missing");
  }
  if (!oneOf(KINDS, value.kind)) {
    return bad(`kind is ${JSON.stringify(value.kind)}`);
  }
  if (!isObject(value.body)) {
    return bad("body is missing");
  }
  const fault = bodyFault(value.kind, value.body);
  if (fault !== "") {
    return bad(`${fault} is missing or wrong`);
  }
  if (value.caps !== undefined && !(isObject(value.caps) && isCount(value.caps.hops) && isCount(value.caps.wake_limit) && isCount(value.caps.credit_budget) && isCount(value.caps.max_prompts))) {
    return bad("caps is wrong");
  }
  return { ok: true, value: value as unknown as Envelope };
}

// A plain message from a peer that does not speak v1: only `text` is trusted to exist.
export type PlainMessage = { from: string; fromId: string; to: string; sentAt: number; text: string };

export function fromV0(value: unknown): Parsed<PlainMessage> {
  if (!isObject(value) || typeof value.text !== "string") {
    return bad("no text");
  }
  if (value.schema_version !== undefined) {
    return bad("not a v0 message");
  }
  return {
    ok: true,
    value: {
      from: String(value.from ?? ""),
      fromId: String(value.fromId ?? ""),
      to: String(value.to ?? ""),
      sentAt: isCount(value.sentAt) ? value.sentAt : 0,
      text: value.text,
    },
  };
}

export type EnvelopeParts<B extends Body> = {
  id: string;
  thread_id: string;
  reply_to?: string;
  from: string;
  fromId: string;
  fromTitle?: string;
  to: string;
  sent_at: number;
  kind: Kind;
  body: B;
  text: string;
  context?: Record<string, unknown>;
  caps?: Caps;
};

// Builds an envelope, filling the v0 fields from the v1 ones.
export function makeEnvelope<B extends Body>(parts: EnvelopeParts<B>): Envelope<B> {
  return { schema_version: SCHEMA_VERSION, ...parts, sentAt: parts.sent_at };
}

export const emptyUsage = (): Usage => ({ prompts: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, credits: 0 });
