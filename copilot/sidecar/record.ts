// What the sidecar writes down: its own log, the audit log, and the task's events.
// Logs hold ids, kinds and sizes. The audit log also holds exactly what was asked and decided.

import { auditFile, eventName } from "../protocol/layout.ts";
import type { TaskPaths } from "../protocol/layout.ts";
import type { EventBody } from "../protocol/schema.ts";
import { appendLine, writeJson } from "./files.ts";

export type Log = (level: "info" | "warn" | "error", event: string, fields?: Record<string, string | number | boolean | null>) => void;

// One JSON object a line, in the task's own log file.
export function makeLog(file: string, taskId: string): Log {
  return (level, event, fields = {}) => {
    appendLine(file, JSON.stringify({ at: new Date().toISOString(), level, task: taskId, event, ...fields }));
  };
}

export type Audit = (what: "task" | "request" | "decision" | "breach" | "outcome" | "mode", fields: Record<string, unknown>) => void;

export function makeAudit(root: string, taskId: string): Audit {
  return (what, fields) => {
    const now = new Date();
    appendLine(auditFile(root, now.toISOString().slice(0, 10)), JSON.stringify({ at: now.toISOString(), task: taskId, what, ...fields }));
  };
}

const FLUSH_CHARS = 2_000;
// Streamed text is written at least this often, so the attach viewer shows it as it comes.
const FLUSH_MS = 400;

// The task's events, one small file each, numbered so their names sort in order. Text that
// streams in pieces (a message, a thought) is gathered into one event until something else
// happens, it grows long, or FLUSH_MS passes; readers join consecutive pieces of one type.
export class EventLog {
  private seq = 0;
  private held: { type: "message" | "thought"; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly paths: TaskPaths;
  private readonly taskId: string;

  constructor(paths: TaskPaths, taskId: string) {
    this.paths = paths;
    this.taskId = taskId;
  }

  text(type: "message" | "thought", piece: string): void {
    if (this.held && this.held.type !== type) {
      this.flush();
    }
    this.held = { type, text: (this.held?.text ?? "") + piece };
    if (this.held.text.length >= FLUSH_CHARS) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  add(type: EventBody["type"], text?: string, data?: Record<string, unknown>): void {
    this.flush();
    this.write({ type, ...(text === undefined ? {} : { text }), ...(data === undefined ? {} : { data }) });
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const held = this.held;
    this.held = null;
    if (held && held.text !== "") {
      this.write(held);
    }
  }

  private write(event: Pick<EventBody, "type" | "text" | "data">): void {
    this.seq += 1;
    const body: EventBody = { task_id: this.taskId, seq: this.seq, ...event };
    writeJson(`${this.paths.events}/${eventName(this.seq)}`, body);
  }
}
