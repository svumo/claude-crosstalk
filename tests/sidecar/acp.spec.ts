// The ACP adapter against the fake ACP server: a real child process and real JSON-RPC.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AcpBackend } from "../../copilot/backend/acp.ts";
import { BackendGone } from "../../copilot/backend/adapter.ts";
import type { BackendEvent, PermissionAnswer, PermissionAsk } from "../../copilot/backend/adapter.ts";

export const FAKE = [process.execPath, fileURLToPath(new URL("../fake-acp/server.ts", import.meta.url))];

const env = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? "", ...extra });

async function run(prompt: string, answer: PermissionAnswer) {
  const cwd = mkdtempSync(join(tmpdir(), "xt-acp-"));
  const backend = new AcpBackend(FAKE);
  const events: BackendEvent[] = [];
  const asks: PermissionAsk[] = [];
  await backend.start({ cwd, env: env() });
  const result = await backend.prompt(prompt, {
    onEvent: (event) => events.push(event),
    onPermission: async (ask) => {
      asks.push(ask);
      return answer;
    },
  });
  await backend.stop();
  return { cwd, events, asks, result };
}

test("a turn streams messages and tool calls, asks before writing, and reports usage", async () => {
  const { cwd, events, asks, result } = await run("Do the task", "allow");
  assert.equal(result.stop, "end_turn");
  assert.deepEqual(result.usage, { inputTokens: 1_000, outputTokens: 200, cachedTokens: 400 });
  assert.equal(asks.length, 1); // it came with id 0, and was still answered
  assert.equal(asks[0]?.kind, "write");
  assert.deepEqual(asks[0]?.paths, [join(cwd, "copilot-was-here.txt")]);
  assert.ok(existsSync(join(cwd, "copilot-was-here.txt")));
  assert.ok(events.some((e) => e.type === "message" && e.text.includes("Wrote the file")));
  const done = events.find((e) => e.type === "tool" && e.status === "done");
  assert.ok(done);
  const first = events.find((e) => e.type === "tool");
  assert.equal(first?.type === "tool" ? first.diffs[0]?.after : "", "hello\n");
});

test("a rejected request stops the write", async () => {
  const { cwd, events } = await run("Do the task", "reject");
  assert.equal(existsSync(join(cwd, "copilot-was-here.txt")), false);
  assert.ok(events.some((e) => e.type === "tool" && e.status === "failed"));
});

test("a shell request carries the real command, not the title's summary", async () => {
  const { asks } = await run("[shell]", "reject");
  assert.equal(asks[0]?.kind, "shell");
  assert.equal(asks[0]?.command, "npm test -- --watch=false");
  assert.equal(asks[0]?.title, "Run a harmless check");
});

test("cancel ends the turn as cancelled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "xt-acp-"));
  const backend = new AcpBackend(FAKE);
  await backend.start({ cwd, env: env() });
  const turn = backend.prompt("[slow]", { onEvent: () => {}, onPermission: async () => "reject" });
  setTimeout(() => void backend.cancel(), 100);
  assert.equal((await turn).stop, "cancelled");
  await backend.stop();
  await backend.stop(); // twice is safe
});

test("a backend that dies mid-turn is reported as gone", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "xt-acp-"));
  const backend = new AcpBackend(FAKE);
  await backend.start({ cwd, env: env() });
  await assert.rejects(backend.prompt("[crash]", { onEvent: () => {}, onPermission: async () => "reject" }), BackendGone);
  await backend.stop();
});

test("a backend on another protocol version is refused, and one that cannot start says so", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "xt-acp-"));
  await assert.rejects(new AcpBackend(FAKE).start({ cwd, env: env({ FAKE_ACP_VERSION: "2" }) }), /ACP version 2/);
  await assert.rejects(new AcpBackend(["no-such-copilot-binary"]).start({ cwd, env: env() }), BackendGone);
});
