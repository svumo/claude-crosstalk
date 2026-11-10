// A stand-in for `copilot --acp --stdio`, for tests: it speaks the Agent Client Protocol over
// stdin and stdout and plays a script chosen by a marker in the prompt.
//
//   (no marker)      a message, then asks to write copilot-was-here.txt in its folder, writes it if
//                    allowed, and ends the turn
//   [shell]          asks to run a command; the request's title hides the command, as Copilot's has
//   [outside]        asks to write a file outside its folder
//   [no-permission]  writes a file without asking (what CLI 1.0.81 to 1.0.104 did)
//   [slow]           works until cancelled
//   [crash]          exits in the middle of the turn
//   [quiet]          a message only
//
// The first permission request of a process goes out with id 0, which Copilot has done.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Bag = Record<string, unknown>;

let cwd = process.cwd();
let nextId = 0;
let isCancelled = false;
const waiting = new Map<number, (result: Bag) => void>();

const send = (message: Bag): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

const update = (body: Bag): void => send({ method: "session/update", params: { sessionId: "fake-1", update: body } });
const say = (text: string): void => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ask(toolCall: Bag): Promise<boolean> {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve) => {
    waiting.set(id, (result) => resolve(String((result.outcome as Bag | undefined)?.optionId ?? "") === "yes"));
    send({
      id,
      method: "session/request_permission",
      params: {
        sessionId: "fake-1",
        toolCall,
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });
}

async function write(path: string, isAsking: boolean): Promise<void> {
  const call = { toolCallId: "t1", title: `Edit ${path}`, kind: "edit", status: "pending", locations: [{ path }], content: [{ type: "diff", path, oldText: null, newText: "hello\n" }] };
  update({ sessionUpdate: "tool_call", ...call });
  if (isAsking && !(await ask(call))) {
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
    say("I was not allowed to write the file.");
    return;
  }
  update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
  writeFileSync(path, "hello\n");
  update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
  say("Wrote the file.");
}

async function turn(prompt: string): Promise<Bag> {
  isCancelled = false;
  const usage = { inputTokens: 1_000, outputTokens: 200, cachedReadTokens: 400 };
  say("Looking at the task. ");
  if (prompt.includes("[quiet]")) {
    say("Nothing to change.");
  } else if (prompt.includes("[crash]")) {
    process.exit(3);
  } else if (prompt.includes("[slow]")) {
    while (!isCancelled) {
      await pause(20);
    }
    return { stopReason: "cancelled", usage };
  } else if (prompt.includes("[shell]")) {
    const call = { toolCallId: "t2", title: "Run a harmless check", kind: "execute", status: "pending", rawInput: { command: "npm test -- --watch=false" } };
    update({ sessionUpdate: "tool_call", ...call });
    const isAllowed = await ask(call);
    update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: isAllowed ? "completed" : "failed" });
    say(isAllowed ? "The tests pass." : "I was not allowed to run the tests.");
  } else if (prompt.includes("[outside]")) {
    await write(join(cwd, "..", "outside.txt"), true);
  } else if (prompt.includes("[no-permission]")) {
    await write(join(cwd, "unapproved.txt"), false);
  } else {
    // FAKE_ACP_UNSAFE makes every write skip the request, as a backend whose approvals are broken.
    await write(join(cwd, "copilot-was-here.txt"), process.env.FAKE_ACP_UNSAFE !== "1");
  }
  return { stopReason: isCancelled ? "cancelled" : "end_turn", usage };
}

async function handle(message: Bag): Promise<void> {
  const params = (message.params ?? {}) as Bag;
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: Number(process.env.FAKE_ACP_VERSION ?? 1), agentInfo: { name: "fake-copilot", version: "0.0.1" }, agentCapabilities: { loadSession: true } } });
      return;
    case "session/new":
      cwd = String(params.cwd ?? cwd);
      send({ id: message.id, result: existsSync(cwd) ? { sessionId: "fake-1" } : {} });
      return;
    case "session/prompt": {
      const text = ((params.prompt as Bag[] | undefined) ?? []).map((block) => String(block.text ?? "")).join("\n");
      send({ id: message.id, result: await turn(text) });
      return;
    }
    case "session/cancel":
      isCancelled = true;
      for (const resolve of waiting.values()) {
        resolve({ outcome: { outcome: "cancelled" } });
      }
      waiting.clear();
      return;
    default:
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: "unknown method" } });
      }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as Bag;
  if (typeof message.method === "string") {
    void handle(message);
    return;
  }
  const resolve = waiting.get(Number(message.id));
  if (resolve) {
    waiting.delete(Number(message.id));
    resolve((message.result ?? {}) as Bag);
  }
}).on("close", () => process.exit(0));
