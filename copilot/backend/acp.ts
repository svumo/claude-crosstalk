// A Copilot backend over the Agent Client Protocol: `copilot --acp --stdio` as a child process.
//
// ACP in Copilot CLI is a public preview. Its permission requests stopped arriving in CLI 1.0.81 to
// 1.0.104, so this adapter is never trusted alone: the sidecar's tripwire watches every tool call.
// The client advertises no file or terminal capability; Copilot runs its own tools either way.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { askOf, eventOf, outcomeFor, turnOf } from "./acp-map.ts";
import { BackendGone } from "./adapter.ts";
import type { BackendInfo, CopilotBackend, StartOptions, TurnHandlers, TurnResult } from "./adapter.ts";
import { JsonRpcPeer, RpcError } from "./jsonrpc.ts";

const PROTOCOL_VERSION = 1;
const STOP_GRACE_MS = 2_000;

// The command that starts Copilot's ACP server. The temp folder is taken out of its allowed paths.
export function copilotAcpCommand(model?: string): string[] {
  return ["copilot", "--acp", "--stdio", "--disallow-temp-dir", ...(model ? ["--model", model] : [])];
}

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag => (typeof v === "object" && v !== null ? (v as Bag) : {});

export class AcpBackend implements CopilotBackend {
  private readonly command: string[];
  private child: ChildProcess | null = null;
  private peer: JsonRpcPeer | null = null;
  private sessionId = "";
  private turn: TurnHandlers | null = null;
  private isGone = false;

  constructor(command: string[]) {
    this.command = command;
  }

  async start(options: StartOptions): Promise<BackendInfo> {
    const [file, ...args] = this.command;
    if (!file) {
      throw new Error("no backend command");
    }
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.child = child;
    const started = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new BackendGone(`could not start ${file}: ${error.message}`)));
    });
    child.once("exit", () => this.gone());
    await started;
    this.peer = new JsonRpcPeer(child.stdout!, child.stdin!, {
      onRequest: (method, params) => this.onRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onClose: () => this.gone(),
    });
    const hello = bag(await this.call("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "crosstalk-copilot", version: "1" },
    }));
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      await this.stop();
      throw new Error(`the backend speaks ACP version ${JSON.stringify(hello.protocolVersion)}, and this adapter speaks ${PROTOCOL_VERSION}`);
    }
    const session = bag(await this.call("session/new", { cwd: options.cwd, mcpServers: [] }));
    this.sessionId = String(session.sessionId ?? "");
    if (this.sessionId === "") {
      await this.stop();
      throw new Error("the backend opened no session");
    }
    const agent = bag(hello.agentInfo);
    return { name: String(agent.name ?? "acp"), version: String(agent.version ?? "") };
  }

  async prompt(text: string, handlers: TurnHandlers): Promise<TurnResult> {
    this.turn = handlers;
    try {
      return turnOf(await this.call("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }));
    } finally {
      this.turn = null;
    }
  }

  async cancel(): Promise<void> {
    this.peer?.notify("session/cancel", { sessionId: this.sessionId });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin?.end(); // the ACP server shuts down when its input closes
    const timer = setTimeout(() => child.kill(), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    if (!this.peer || this.isGone) {
      throw new BackendGone("the backend is not running");
    }
    try {
      return await this.peer.request(method, params);
    } catch (error) {
      if (this.isGone) {
        throw new BackendGone(`the backend ended during ${method}`);
      }
      throw error;
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") {
      throw new RpcError(-32601, `${method} is not offered by this client`);
    }
    const { ask, options } = askOf(params);
    // With no turn to ask, nobody can approve: the request is refused.
    const answer = this.turn ? await this.turn.onPermission(ask) : "reject";
    return outcomeFor(answer, options);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") {
      return;
    }
    const event = eventOf(params);
    if (event) {
      this.turn?.onEvent(event);
    }
  }

  private gone(): void {
    if (this.isGone) {
      return;
    }
    this.isGone = true;
    this.peer?.close();
  }
}
