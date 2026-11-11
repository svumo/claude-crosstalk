// JSON-RPC 2.0 over newline-delimited JSON, both ways, on a pair of streams.
// A request's id may be 0 (Copilot has sent one), so ids are tested for presence, never truthiness.

import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

export type RpcHandlers = {
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  onClose: () => void;
};

export class RpcError extends Error {
  override name = "RpcError";
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const hasId = (message: Record<string, unknown>): boolean => message.id !== undefined && message.id !== null;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private isClosed = false;
  private readonly output: Writable;
  private readonly handlers: RpcHandlers;

  constructor(input: Readable, output: Writable, handlers: RpcHandlers) {
    this.output = output;
    this.handlers = handlers;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => this.take(line));
    lines.on("close", () => this.close());
    output.on("error", () => this.close());
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.isClosed) {
      return Promise.reject(new RpcError(-32000, "connection closed"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.isClosed) {
      this.send({ jsonrpc: "2.0", method, params });
    }
  }

  private send(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private take(line: string): void {
    if (line.trim() === "") {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not protocol traffic
    }
    if (typeof message !== "object" || message === null) {
      return;
    }
    const m = message as Record<string, unknown>;
    if (typeof m.method === "string") {
      if (hasId(m)) {
        void this.answer(m.id, m.method, m.params);
      } else {
        this.handlers.onNotification(m.method, m.params);
      }
      return;
    }
    const waiting = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
    if (!waiting) {
      return;
    }
    this.waiting.delete(m.id as number);
    if (typeof m.error === "object" && m.error !== null) {
      const error = m.error as Record<string, unknown>;
      waiting.reject(new RpcError(Number(error.code ?? -32000), String(error.message ?? "error")));
    } else {
      waiting.resolve(m.result);
    }
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      this.send({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    for (const waiting of this.waiting.values()) {
      waiting.reject(new RpcError(-32000, "connection closed"));
    }
    this.waiting.clear();
    this.handlers.onClose();
  }
}
