// The SDK adapter against a stand-in SDK (tests/fake-sdk), loaded by path as the real one is.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { BackendGone } from "../../copilot/backend/adapter.ts";
import type { BackendEvent, PermissionAnswer, PermissionAsk } from "../../copilot/backend/adapter.ts";
import { SdkBackend } from "../../copilot/backend/sdk.ts";
import { askOf, toolOf } from "../../copilot/backend/sdk-map.ts";
import type { Mode } from "../../copilot/protocol/schema.ts";
import { runTurn } from "../../copilot/sidecar/turn.ts";
import { chooseBackend } from "../../copilot/sidecar/settings.ts";
import { installArgs, npmCommand } from "../../copilot/sidecar/setup.ts";
import { Tripwire } from "../../copilot/sidecar/tripwire.ts";
import { fake } from "../fake-sdk/index.ts";

const ENTRY = fileURLToPath(new URL("../fake-sdk/index.ts", import.meta.url));
const folder = (): string => mkdtempSync(join(tmpdir(), "xt-sdk-"));

function reset(): void {
  Object.assign(fake, { authenticated: true, login: "octocat", version: "9.9.9", started: 0, stopped: 0, disconnected: 0, envSeen: {} });
}

async function run(prompt: string, answer: PermissionAnswer) {
  reset();
  const cwd = folder();
  const backend = new SdkBackend(ENTRY);
  const events: BackendEvent[] = [];
  const asks: PermissionAsk[] = [];
  const info = await backend.start({ cwd, env: { PATH: "x" } });
  const result = await backend.prompt(prompt, {
    onEvent: (event) => events.push(event),
    onPermission: async (ask) => {
      asks.push(ask);
      return answer;
    },
  });
  await backend.stop();
  return { cwd, info, events, asks, result };
}

test("start reports the version and the signed-in login, and passes only the given environment", async () => {
  const { info } = await run("go", "allow");
  assert.deepEqual(info, { name: "copilot-sdk", version: "9.9.9", account: "octocat" });
  assert.deepEqual(fake.envSeen, { PATH: "x" });
  assert.equal(fake.disconnected, 1);
  assert.ok(fake.stopped >= 1);
});

test("an approved write runs, streams its message once, and adds up usage", async () => {
  const { cwd, events, asks, result } = await run("go", "allow");
  assert.equal(result.stop, "end_turn");
  assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 30, cachedTokens: 40 });
  assert.equal(asks.length, 1);
  assert.equal(asks[0]?.kind, "write");
  assert.deepEqual(asks[0]?.paths, [join(cwd, "out.txt")]);
  assert.ok(existsSync(join(cwd, "out.txt")));
  const said = events.filter((e) => e.type === "message").map((e) => (e.type === "message" ? e.text : "")).join("");
  assert.equal(said, "Wrote out.txt.");
  const tools = events.filter((e) => e.type === "tool");
  assert.deepEqual(tools.map((e) => (e.type === "tool" ? [e.status, e.kind] : [])), [["pending", "other"], ["done", "write"]]);
});

test("a tool's announcement comes before its request, so it is not taken for a run", async () => {
  const { events } = await run("go", "allow");
  const wire = new Tripwire();
  const first = events.find((e) => e.type === "tool");
  assert.ok(first);
  assert.equal(wire.check(first, false), "");
});

test("a refused request ends the turn as denied, not as cancelled, and nothing is written", async () => {
  const { cwd, events, result } = await run("go", "reject");
  assert.equal(result.stop, "denied");
  assert.equal(existsSync(join(cwd, "out.txt")), false);
  assert.ok(events.some((e) => e.type === "tool" && e.status === "failed"));
});

test("a tool that finishes without asking trips the tripwire", async () => {
  const { events, asks } = await run("[unasked]", "allow");
  assert.equal(asks.length, 0);
  const wire = new Tripwire();
  const problems = events.map((e) => wire.check(e, false)).filter((p) => p !== "");
  assert.equal(problems.length, 1);
});

test("a shell call Copilot ran without asking still carries its command and paths", () => {
  const known = new Map();
  const start = toolOf("tool.execution_start", { toolCallId: "c1", toolName: "powershell", arguments: { command: "git status" }, shellToolInfo: { possiblePaths: ["a.txt"], hasWriteFileRedirection: false } }, new Map(), known);
  assert.equal(start.kind, "shell");
  assert.equal(start.command, "git status");
  assert.deepEqual(start.paths, ["a.txt"]);
  const done = toolOf("tool.execution_complete", { toolCallId: "c1", success: true }, new Map(), known);
  assert.equal(done.command, "git status");
  assert.match(new Tripwire().check(done, false), /ran a shell tool with no approval: git status/);
  const shown = toolOf("tool.execution_start", { toolCallId: "c2", toolName: "bash", shellToolInfo: { displayCommand: "ls", possiblePaths: [] } }, new Map(), new Map());
  assert.equal(shown.command, "ls");
});

// A turn against a backend that runs one shell command without asking, in the given mode.
async function unaskedTurn(mode: Mode) {
  const added: string[] = [];
  let stopped = false;
  const backend = {
    prompt: async (_p: string, h: { onEvent: (e: BackendEvent) => void }) => {
      h.onEvent({ type: "tool", id: "c1", kind: "shell", title: "Running command", status: "done", command: "git status", paths: [], diffs: [] });
      return { stop: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
    },
    cancel: async () => {},
    stop: async () => { stopped = true; },
  };
  const end = await runTurn("go", {
    backend: backend as never,
    events: { add: (type: string, text?: string) => void added.push(`${type}: ${text ?? ""}`), text: () => {}, flush: () => {} } as never,
    broker: { close: () => {}, decide: async () => "allow" } as never,
    tripwire: new Tripwire(), worktree: folder(), timeoutMs: 60_000, shouldStop: () => false, log: () => {}, mode: () => mode,
  });
  return { end, added, stopped };
}

test("in bypass a tool that ran without asking is written down and the turn goes on", async () => {
  const { end, added, stopped } = await unaskedTurn("bypass");
  assert.equal(end.kind, "done");
  assert.equal(stopped, false);
  assert.ok(added.includes("permission: ran without asking (bypass): git status"));
});

test("in ask and auto a tool that ran without asking still stops the task, naming the command", async () => {
  for (const mode of ["ask", "auto"] as const) {
    const { end, stopped } = await unaskedTurn(mode);
    assert.equal(end.kind, "breach");
    assert.equal(stopped, true);
    assert.match(end.kind === "breach" ? end.detail : "", /git status/);
  }
});

test("cancel ends the turn as cancelled", async () => {
  reset();
  const backend = new SdkBackend(ENTRY);
  await backend.start({ cwd: folder(), env: {} });
  const turn = backend.prompt("[slow]", { onEvent: () => {}, onPermission: async () => "reject" });
  setTimeout(() => void backend.cancel(), 50);
  assert.equal((await turn).stop, "cancelled");
  await backend.stop();
  await backend.stop(); // twice is safe
});

test("a session error fails the turn", async () => {
  reset();
  const backend = new SdkBackend(ENTRY);
  await backend.start({ cwd: folder(), env: {} });
  await assert.rejects(backend.prompt("[error]", { onEvent: () => {}, onPermission: async () => "reject" }), /model is unavailable/);
  await backend.stop();
});

test("start refuses when Copilot is not signed in, or is signed in as another account", async () => {
  reset();
  fake.authenticated = false;
  await assert.rejects(new SdkBackend(ENTRY).start({ cwd: folder(), env: {} }), /not signed in.*copilot login/);
  reset();
  await assert.rejects(new SdkBackend(ENTRY, "Someone-Else").start({ cwd: folder(), env: {} }), /signed in as octocat.*someone-else only/);
  reset();
  assert.equal((await new SdkBackend(ENTRY, " OctoCat ").start({ cwd: folder(), env: {} })).account, "octocat");
});

test("with no SDK installed, start says to run /crosstalk-gh setup", async () => {
  await assert.rejects(new SdkBackend(join(folder(), "missing.js")).start({ cwd: folder(), env: {} }), (error: unknown) => error instanceof BackendGone && /\/crosstalk-gh setup/.test(error.message));
});

test("a shell request carries the whole command; unknown kinds are 'other'", () => {
  const shell = askOf({ kind: "shell", toolCallId: "a", intention: "Run tests", fullCommandText: "npm test", possiblePaths: ["/w/x"] });
  assert.deepEqual(shell, { toolId: "a", kind: "shell", title: "Run tests", command: "npm test", paths: ["/w/x"] });
  assert.equal(askOf({ kind: "mcp", toolCallId: "b" }).kind, "other");
  assert.equal(askOf({ kind: "url", url: "https://x.test" }).url, "https://x.test");
});

test("the backend follows the settings, and the SDK when it is installed", () => {
  assert.equal(chooseBackend({ backend: "auto", backendCommand: [] }, true), "sdk");
  assert.equal(chooseBackend({ backend: "auto", backendCommand: [] }, false), "acp");
  assert.equal(chooseBackend({ backend: "acp", backendCommand: [] }, true), "acp");
  assert.equal(chooseBackend({ backend: "sdk", backendCommand: [] }, false), "sdk");
  assert.equal(chooseBackend({ backend: "auto", backendCommand: ["gemini", "--acp"] }, true), "acp");
});

test("setup installs the pinned SDK with install scripts off, through this Node's npm", () => {
  const args = installArgs("/x/runtime");
  assert.ok(args.includes("--ignore-scripts"));
  assert.ok(args.some((a) => /^@github\/copilot-sdk@\d+\.\d+\.\d+$/.test(a)));
  assert.deepEqual(npmCommand("/n/node", () => false), null);
  assert.equal(npmCommand("/n/node", (p) => p.includes("lib"))?.[0], "/n/node");
});
