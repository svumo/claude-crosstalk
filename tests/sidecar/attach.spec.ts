// The attach viewer: what it prints for each event, and, run for real against a task folder, that
// a key answers a request, s stops the task, and it ends with the task.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { eventName, taskPaths } from "../../copilot/protocol/layout.ts";
import type { TaskStateFile } from "../../copilot/protocol/layout.ts";
import type { EventBody, PermissionRequestBody } from "../../copilot/protocol/schema.ts";
import { EventLog } from "../../copilot/sidecar/record.ts";
import { clean, keyDecision, lineDiff, newMemory, PLAIN, renderEvent } from "../../copilot/tui/view.ts";

const ATTACH = fileURLToPath(new URL("../../copilot/tui/attach.ts", import.meta.url));
const TASK = "fix-the-thing-ab12";
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("clean strips escape sequences and bidi overrides but keeps text, tabs and newlines", () => {
  assert.equal(clean("a\u001b]0;pwned\u0007b\u001b[2Jc\r\nd\te‮F"), "a]0;pwnedb[2Jc\nd\teF");
});

test("lineDiff marks changed lines with context and folds the rest", () => {
  const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
  const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n");
  assert.deepEqual(lineDiff(before, after), [
    { sign: "…", text: "" }, { sign: " ", text: "3" }, { sign: " ", text: "4" },
    { sign: "-", text: "5" }, { sign: "+", text: "five" },
    { sign: " ", text: "6" }, { sign: " ", text: "7" }, { sign: "…", text: "" },
  ]);
  assert.deepEqual(lineDiff(null, "new\n"), [{ sign: "+", text: "new" }]);
});

test("renderEvent joins a streamed message, prints a tool's status once, and its diff when done", () => {
  const memory = newMemory();
  const ev = (seq: number, type: EventBody["type"], text?: string, data?: Record<string, unknown>): EventBody => ({ task_id: TASK, seq, type, ...(text === undefined ? {} : { text }), ...(data ? { data } : {}) });
  assert.deepEqual(renderEvent(ev(1, "message", "Hello "), memory, PLAIN), ["", "Copilot:", "Hello "]);
  assert.deepEqual(renderEvent(ev(2, "message", "there"), memory, PLAIN), ["there"]);
  const tool = { id: "t1", kind: "write", command: null, paths: ["a.txt"], diffs: [{ path: "a.txt", before: null, after: "hi\n" }] };
  assert.deepEqual(renderEvent(ev(3, "tool", "Write a.txt", { ...tool, status: "running" }), memory, PLAIN), ["▶ write Write a.txt"]);
  assert.deepEqual(renderEvent(ev(4, "tool", "Write a.txt", { ...tool, status: "running" }), memory, PLAIN), []);
  assert.deepEqual(renderEvent(ev(5, "tool", "Write a.txt", { ...tool, status: "done" }), memory, PLAIN), ["✓ write Write a.txt", "  a.txt (new file)", "  + hi"]);
  assert.deepEqual(renderEvent(ev(6, "tool", "Write a.txt", { ...tool, status: "done" }), memory, PLAIN), []);
  assert.deepEqual(renderEvent(ev(7, "state", "working"), memory, PLAIN), []);
  assert.deepEqual(renderEvent(ev(8, "message", "after"), memory, PLAIN), ["", "Copilot:", "after"]);
});

test("keyDecision offers allow-for-task only when the request does", () => {
  const body = { task_grant: null } as unknown as PermissionRequestBody;
  assert.equal(keyDecision("y", body), "approve");
  assert.equal(keyDecision("N", body), "deny");
  assert.equal(keyDecision("a", body), null);
  assert.equal(keyDecision("a", { ...body, task_grant: "all writes inside the worktree" }), "allow_task");
  assert.equal(keyDecision("x", body), null);
});

test("EventLog writes streamed text within half a second, before anything else happens", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xt-events-")));
  const paths = taskPaths(root, TASK);
  mkdirSync(paths.events, { recursive: true });
  const log = new EventLog(paths, TASK);
  log.text("message", "partial");
  assert.equal(existsSync(`${paths.events}/${eventName(1)}`), false);
  await pause(700);
  assert.equal((JSON.parse(readFileSync(`${paths.events}/${eventName(1)}`, "utf8")) as EventBody).text, "partial");
  rmSync(root, { recursive: true, force: true });
});

type Viewer = { out: () => string; send: (keys: string) => void; exited: Promise<number> };

function startViewer(root: string): Viewer {
  const child = spawn(process.execPath, [ATTACH, TASK, "--root", root, "--no-color"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += String(chunk); });
  child.stderr.on("data", (chunk) => { out += String(chunk); });
  return {
    out: () => out,
    send: (keys) => child.stdin.write(keys),
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1))),
  };
}

async function until(what: string, check: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await pause(50);
  }
}

function fakeTask(root: string): { paths: ReturnType<typeof taskPaths>; state: TaskStateFile } {
  const paths = taskPaths(root, TASK);
  for (const dir of [paths.events, paths.requests, paths.decisions]) {
    mkdirSync(dir, { recursive: true });
  }
  const state: TaskStateFile = {
    task_id: TASK, state: "awaiting_approval", detail: "r1", task: "Fix the thing", origin_id: "o", origin_address: "a/b", branch: `copilot/${TASK}`,
    worktree: `${root}/wt`, backend: "acp", model: "", mode: "ask", pending: ["r1"], started_at: Date.now(), updated_at: Date.now(), pid: 1,
    usage: { prompts: 1, input_tokens: 10, output_tokens: 5, cached_tokens: 0, credits: 0.5 },
  };
  writeFileSync(paths.state, JSON.stringify(state));
  const events: EventBody[] = [
    { task_id: TASK, seq: 1, type: "message", text: "I will \u001b]0;pwned\u0007write it." },
    { task_id: TASK, seq: 2, type: "tool", text: "Run tests", data: { id: "t1", kind: "shell", status: "pending", command: "npm test", paths: [], diffs: [] } },
  ];
  events.forEach((e) => writeFileSync(`${paths.events}/${eventName(e.seq)}`, JSON.stringify(e)));
  const request: PermissionRequestBody = {
    task_id: TASK, request_id: "r1", tool_kind: "shell", title: "Run tests", command: "npm test", scope: "worktree", risk: "high", task_grant: null, expires_at: Date.now() + 600_000,
  };
  writeFileSync(`${paths.requests}/r1.json`, JSON.stringify(request));
  return { paths, state };
}

test("attach shows the task, answers a request from a key, and ends with the task", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xt-attach-"))).replace(/\\/g, "/");
  const { paths, state } = fakeTask(root);
  const viewer = startViewer(root);
  try {
    await until("the request card", () => viewer.out().includes("Copilot asks (r1)"));
    assert.match(viewer.out(), /Copilot task fix-the-thing-ab12/);
    assert.match(viewer.out(), /\$ npm test/);
    assert.ok(!viewer.out().includes("\u001b"), "no escape sequence reaches the terminal");
    viewer.send("a"); // not offered by this request: ignored
    viewer.send("y");
    await until("the decision file", () => existsSync(`${paths.decisions}/r1.json`));
    const decision = JSON.parse(readFileSync(`${paths.decisions}/r1.json`, "utf8")) as { decision: string; decided_by: string };
    assert.deepEqual([decision.decision, decision.decided_by], ["approve", "terminal"]);
    // The sidecar takes it: the request goes, the tool runs, the task ends.
    rmSync(`${paths.requests}/r1.json`);
    writeFileSync(`${paths.events}/${eventName(3)}`, JSON.stringify({ task_id: TASK, seq: 3, type: "tool", text: "Run tests", data: { id: "t1", kind: "shell", status: "done", command: "npm test", paths: [], diffs: [] } }));
    writeFileSync(paths.state, JSON.stringify({ ...state, state: "completed", pending: [] }));
    assert.equal(await viewer.exited, 0);
    assert.match(viewer.out(), /Approved: r1\./);
    assert.match(viewer.out(), /✓ shell Run tests/);
    assert.match(viewer.out(), /Task completed\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attach stops the task on s then y, and q closes it with the task still running", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xt-attach-"))).replace(/\\/g, "/");
  const { paths, state } = fakeTask(root);
  rmSync(`${paths.requests}/r1.json`);
  writeFileSync(paths.state, JSON.stringify({ ...state, state: "working", pending: [] }));
  const viewer = startViewer(root);
  try {
    await until("the header", () => viewer.out().includes("Keys:"));
    viewer.send("s");
    await until("the stop question", () => viewer.out().includes("Stop the task?"));
    viewer.send("y");
    await until("the stop file", () => existsSync(paths.stop));
    viewer.send("q");
    assert.equal(await viewer.exited, 0);
    assert.match(viewer.out(), /The task keeps running/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
