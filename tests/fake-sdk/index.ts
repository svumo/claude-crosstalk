// A stand-in for @github/copilot-sdk, for the SDK adapter's tests: the few members the adapter
// uses, with the event order seen live on 1.0.30 (a tool is announced, then asked about, then
// ends; a refused request makes the SDK abort the turn itself).
//
// Tests set `fake` (this module, imported by the same path) to choose the sign-in and to read
// back what happened. What a turn does depends on the prompt:
//   anything      announce a write, ask, write the file if approved, answer, end
//   [unasked]     announce a write and finish it without asking (a permission channel failing open)
//   [slow]        wait until aborted
//   [error]       report a session error

import { writeFileSync } from "node:fs";
import { join } from "node:path";

type Handler = (event: { type: string; data?: unknown }) => void;
type Ask = (request: unknown) => Promise<{ kind: string }>;

export const fake = {
  authenticated: true,
  login: "octocat",
  version: "9.9.9",
  started: 0,
  stopped: 0,
  disconnected: 0,
  envSeen: {} as Record<string, string>,
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

class Session {
  private readonly handlers: Handler[] = [];
  private aborted = false;
  private wake: (() => void) | null = null;

  private readonly cwd: string;
  private readonly ask: Ask;

  constructor(cwd: string, ask: Ask) {
    this.cwd = cwd;
    this.ask = ask;
  }

  on(handler: Handler): () => void {
    this.handlers.push(handler);
    return () => {};
  }

  private emit(type: string, data: unknown = {}): void {
    for (const handler of this.handlers) {
      handler({ type, data });
    }
  }

  async send(options: { prompt: string }): Promise<string> {
    void this.play(options.prompt);
    return "message-1";
  }

  private async play(prompt: string): Promise<void> {
    await tick();
    if (prompt === "[error]") {
      this.emit("session.error", { errorType: "model", message: "the model is unavailable" });
      return;
    }
    if (prompt === "[slow]") {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.emit("session.idle", { aborted: true });
      return;
    }
    const path = join(this.cwd, "out.txt");
    this.emit("tool.execution_start", { toolCallId: "t1", toolName: "create" });
    if (prompt === "[unasked]") {
      writeFileSync(path, "ok\n");
      this.emit("tool.execution_complete", { toolCallId: "t1", success: true });
      this.emit("session.idle", {});
      return;
    }
    await tick();
    const answer = await this.ask({ kind: "write", toolCallId: "t1", intention: "Create file", fileName: "out.txt", resolvedPath: path });
    if (answer.kind !== "approve-once") {
      this.emit("tool.execution_complete", { toolCallId: "t1", success: false });
      this.emit("session.idle", { aborted: true });
      return;
    }
    writeFileSync(path, "ok\n");
    this.emit("tool.execution_complete", { toolCallId: "t1", success: true });
    this.emit("assistant.message_delta", { messageId: "m1", deltaContent: "Wrote " });
    this.emit("assistant.message_delta", { messageId: "m1", deltaContent: "out.txt." });
    this.emit("assistant.message", { messageId: "m1", content: "Wrote out.txt." });
    this.emit("assistant.usage", { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 });
    this.emit("assistant.usage", { inputTokens: 50, outputTokens: 10 });
    this.emit("session.idle", { aborted: this.aborted });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.wake?.();
  }

  async disconnect(): Promise<void> {
    fake.disconnected += 1;
  }
}

export class CopilotClient {
  constructor(options: { env: Record<string, string> }) {
    fake.envSeen = options.env;
  }

  async start(): Promise<void> {
    fake.started += 1;
  }

  async stop(): Promise<unknown[]> {
    fake.stopped += 1;
    return [];
  }

  async forceStop(): Promise<void> {
    fake.stopped += 1;
  }

  async getStatus(): Promise<{ version: string }> {
    return { version: fake.version };
  }

  async getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }> {
    return fake.authenticated ? { isAuthenticated: true, login: fake.login } : { isAuthenticated: false, statusMessage: "no token found" };
  }

  async createSession(config: { workingDirectory: string; onPermissionRequest: Ask }): Promise<Session> {
    return new Session(config.workingDirectory, config.onPermissionRequest);
  }
}
