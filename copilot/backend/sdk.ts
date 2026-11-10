// A Copilot backend over the official GitHub Copilot SDK (@github/copilot-sdk), which runs its own
// bundled Copilot runtime and talks to it over JSON-RPC.
//
// The SDK is not a dependency of this plugin. `/copilot setup` installs a pinned version into
// Crosstalk's own folder, and it is loaded from there by path. Only the few members used here are
// described, as the shapes this file relies on; the SDK's own declarations are the authority.
//
// Sign-in is the person's: the runtime uses the login they made with `copilot login`, from the OS
// keychain. No token is passed in, and the environment it gets is the sidecar's allow-list, which
// leaves the token variables out.

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { BackendGone, noUsage } from "./adapter.ts";
import type { BackendInfo, CopilotBackend, PermissionAsk, StartOptions, TokenUsage, TurnHandlers, TurnResult } from "./adapter.ts";
import { addUsage, askOf, resultFor, toolOf, usageOf } from "./sdk-map.ts";
import type { ToolEvent } from "./sdk-map.ts";

export const SDK_PACKAGE = "@github/copilot-sdk";
export const SDK_VERSION = "1.0.30";

// Where `/copilot setup` puts the SDK, under Crosstalk's folder.
export const sdkFolder = (root: string): string => `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/copilot/runtime`;
export const sdkEntry = (root: string): string => `${sdkFolder(root)}/node_modules/${SDK_PACKAGE}/dist/index.js`;

type SdkEvent = { type: string; data?: unknown };

type SdkSession = {
  send(options: { prompt: string }): Promise<string>;
  on(handler: (event: SdkEvent) => void): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
};

type SdkClient = {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  forceStop(): Promise<void>;
  getStatus(): Promise<{ version: string }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string; statusMessage?: string }>;
  createSession(config: {
    workingDirectory: string;
    model?: string;
    streaming: boolean;
    onPermissionRequest: (request: unknown) => Promise<{ kind: "approve-once" } | { kind: "reject" }>;
  }): Promise<SdkSession>;
};

type SdkModule = {
  CopilotClient: new (options: { workingDirectory: string; env: Record<string, string>; useLoggedInUser: boolean; logLevel: "error" }) => SdkClient;
};

const STOP_GRACE_MS = 5_000;
const bag = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

type Turn = {
  handlers: TurnHandlers;
  usage: TokenUsage;
  // Messages that streamed in pieces, so their whole text is not shown a second time.
  streamed: Set<string>;
  // A refused request makes the SDK abort the turn itself; a cancel of ours does too. These say which.
  refused: boolean;
  cancelling: boolean;
  end: (result: TurnResult) => void;
  fail: (error: Error) => void;
};

export class SdkBackend implements CopilotBackend {
  private client: SdkClient | null = null;
  private session: SdkSession | null = null;
  private turn: Turn | null = null;
  private readonly asked = new Map<string, PermissionAsk>();
  private readonly tools = new Map<string, ToolEvent>();
  private readonly entry: string;
  private readonly account: string;

  // `entry` is the SDK's module file. `account`, when set, is the only GitHub login allowed.
  constructor(entry: string, account = "") {
    this.entry = entry;
    this.account = account.trim().toLowerCase();
  }

  async start(options: StartOptions): Promise<BackendInfo> {
    if (!existsSync(this.entry)) {
      throw new BackendGone("the Copilot SDK is not installed: run /copilot setup");
    }
    const sdk = (await import(pathToFileURL(this.entry).href)) as SdkModule;
    const client = new sdk.CopilotClient({ workingDirectory: options.cwd, env: options.env, useLoggedInUser: true, logLevel: "error" });
    this.client = client;
    try {
      await client.start();
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        throw new Error(`Copilot is not signed in${auth.statusMessage ? ` (${auth.statusMessage})` : ""}: run \`copilot login\` yourself, in a terminal`);
      }
      const login = String(auth.login ?? "");
      if (this.account !== "" && login.toLowerCase() !== this.account) {
        throw new Error(`Copilot is signed in as ${login || "an unknown account"}, and this computer is set to use ${this.account} only`);
      }
      const status = await client.getStatus();
      this.session = await client.createSession({
        workingDirectory: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        streaming: true,
        onPermissionRequest: (request) => this.onPermission(request),
      });
      this.session.on((event) => this.onEvent(event));
      return { name: "copilot-sdk", version: String(status.version ?? ""), ...(login ? { account: login } : {}) };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  prompt(text: string, handlers: TurnHandlers): Promise<TurnResult> {
    const session = this.session;
    if (!session) {
      return Promise.reject(new BackendGone("the backend is not running"));
    }
    return new Promise<TurnResult>((resolve, reject) => {
      const done = (): void => {
        this.turn = null;
      };
      this.turn = {
        handlers, usage: noUsage(), streamed: new Set(), refused: false, cancelling: false,
        end: (result) => { done(); resolve(result); },
        fail: (error) => { done(); reject(error); },
      };
      session.send({ prompt: text }).catch((error: unknown) => this.turn?.fail(new BackendGone(error instanceof Error ? error.message : String(error))));
    });
  }

  async cancel(): Promise<void> {
    if (this.turn) {
      this.turn.cancelling = true;
    }
    await this.session?.abort();
  }

  async stop(): Promise<void> {
    const client = this.client;
    const session = this.session;
    this.client = null;
    this.session = null;
    this.turn?.fail(new BackendGone("the backend was stopped"));
    if (!client) {
      return;
    }
    await session?.disconnect().catch(() => {});
    const forced = new Promise<void>((resolve) => setTimeout(() => void client.forceStop().catch(() => {}).then(resolve), STOP_GRACE_MS).unref());
    await Promise.race([client.stop().then(() => {}, () => {}), forced]);
  }

  // With no turn to ask, nobody can approve: the request is refused.
  private async onPermission(request: unknown): Promise<{ kind: "approve-once" } | { kind: "reject" }> {
    const ask = askOf(request);
    if (ask.toolId !== "") {
      this.asked.set(ask.toolId, ask);
    }
    const turn = this.turn;
    const answer = turn ? await turn.handlers.onPermission(ask) : "reject";
    if (turn && answer === "reject") {
      turn.refused = true;
    }
    return resultFor(answer);
  }

  private onEvent(event: SdkEvent): void {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    const data = bag(event.data);
    switch (event.type) {
      case "assistant.message_delta":
        turn.streamed.add(String(data.messageId ?? ""));
        turn.handlers.onEvent({ type: "message", text: String(data.deltaContent ?? "") });
        return;
      case "assistant.message":
        if (!turn.streamed.has(String(data.messageId ?? "")) && typeof data.content === "string" && data.content !== "") {
          turn.handlers.onEvent({ type: "message", text: data.content });
        }
        return;
      case "tool.execution_start":
      case "tool.execution_complete":
        turn.handlers.onEvent(toolOf(event.type, data, this.asked, this.tools));
        return;
      case "assistant.usage":
        turn.usage = addUsage(turn.usage, usageOf(data));
        return;
      case "session.idle":
        turn.end({ stop: data.aborted !== true ? "end_turn" : turn.refused && !turn.cancelling ? "denied" : "cancelled", usage: turn.usage });
        return;
      case "session.error":
        turn.fail(new Error(`Copilot reported an error: ${String(data.message ?? data.errorType ?? "unknown")}`));
        return;
      default:
        return;
    }
  }
}
