// A whole task, end to end: a handoff file in, the fake Copilot run in a real git worktree, the
// person's decisions as files, and the reply in the originating session's inbox.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AcpBackend } from "../../copilot/backend/acp.ts";
import { taskPaths } from "../../copilot/protocol/layout.ts";
import type { TaskStateFile } from "../../copilot/protocol/layout.ts";
import { makeEnvelope } from "../../copilot/protocol/schema.ts";
import type { Caps, Decision, Envelope, PermissionRequestBody, ReplyBody, TaskBody } from "../../copilot/protocol/schema.ts";
import { DEFAULT_CAPS } from "../../copilot/sidecar/budget.ts";
import { childEnv } from "../../copilot/sidecar/env.ts";
import { DEFAULT_CONFIG, runTask } from "../../copilot/sidecar/task.ts";

const FAKE = [process.execPath, fileURLToPath(new URL("../fake-acp/server.ts", import.meta.url))];
const MAIN = fileURLToPath(new URL("../../copilot/sidecar/main.ts", import.meta.url));
const ORIGIN = "origin-session";
const slashes = (path: string): string => path.replace(/\\/g, "/");
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type World = { root: string; repo: string; sha: string; taskId: string };

function world(taskId: string): World {
  const base = slashes(realpathSync(mkdtempSync(join(tmpdir(), "xt-task-"))));
  const repo = `${base}/app`;
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test");
  writeFileSync(`${repo}/README.md`, "app\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  return { root: `${base}/crosstalk`, repo, sha: git(repo, "rev-parse", "HEAD"), taskId };
}

function handOver(w: World, task: string, caps: Partial<Caps> = {}): void {
  const paths = taskPaths(w.root, w.taskId);
  mkdirSync(paths.dir, { recursive: true });
  const envelope = makeEnvelope<TaskBody>({
    id: "m1", thread_id: "t1", from: "default/app-ab12", fromId: ORIGIN, to: `copilot/${w.taskId}`, sent_at: Date.now(), kind: "task",
    body: { task_id: w.taskId, task, model: "claude-sonnet-5.5" }, text: task, caps: { ...DEFAULT_CAPS, ...caps },
    context: {
      context_version: 1, captured_at: Date.now(), cwd: w.repo,
      git: { repo_root: w.repo, main_root: w.repo, is_worktree: false, branch: "main", head_sha: w.sha, remote: "", dirty: { staged: 0, unstaged: 0, untracked: 0, paths: [] }, worktrees: [] },
      claude: { profile: "default", config_dir: "", session_id: ORIGIN, transcript_path: "", title: "", model: "" },
      host: { surface: "terminal", emulator: "unknown", os: "unknown", shell: "" }, instructions: [], files_touched: ["README.md"],
    },
  });
  writeFileSync(paths.task, JSON.stringify(envelope));
}

const options = (w: World, config = {}) => ({
  root: w.root, taskId: w.taskId, backendName: "acp", env: childEnv(process.env), makeBackend: () => new AcpBackend(FAKE),
  config: { ...DEFAULT_CONFIG, permissionTimeoutMs: 5_000, turnTimeoutMs: 15_000, idleMs: 400, ...config },
});

// Stands in for the person: answers each request as it appears, the way /copilot approve does.
function person(w: World, answer: (request: PermissionRequestBody) => Decision | null): { seen: PermissionRequestBody[]; stop: () => void } {
  const paths = taskPaths(w.root, w.taskId);
  const seen: PermissionRequestBody[] = [];
  const timer = setInterval(() => {
    for (const name of existsSync(paths.requests) ? readdirSync(paths.requests) : []) {
      const request = JSON.parse(readFileSync(`${paths.requests}/${name}`, "utf8")) as PermissionRequestBody;
      if (seen.some((s) => s.request_id === request.request_id)) {
        continue;
      }
      seen.push(request);
      const decision = answer(request);
      if (decision) {
        writeFileSync(`${paths.decisions}/${request.request_id}.json`, JSON.stringify({ request_id: request.request_id, decision, decided_by: "command", at: Date.now() }));
      }
    }
  }, 50);
  return { seen, stop: () => clearInterval(timer) };
}

function inbox(w: World): Envelope[] {
  const dir = `${w.root}/inbox/${ORIGIN}`;
  return (existsSync(dir) ? readdirSync(dir).sort() : []).map((name) => JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as Envelope);
}

const replies = (w: World): ReplyBody[] => inbox(w).filter((m) => m.kind === "reply").map((m) => m.body as ReplyBody);
const state = (w: World): TaskStateFile => JSON.parse(readFileSync(taskPaths(w.root, w.taskId).state, "utf8")) as TaskStateFile;
const audit = (w: World): string => readdirSync(`${w.root}/copilot/audit`).map((name) => readFileSync(`${w.root}/copilot/audit/${name}`, "utf8")).join("");

test("a task runs in its own worktree, asks before writing, and replies with a summary, diff stat and branch", async () => {
  const w = world("add-file-aaaa");
  handOver(w, "Add the file");
  const p = person(w, () => "approve");
  const ended = await runTask(options(w));
  p.stop();
  assert.equal(ended, "completed");
  const tree = `${w.repo}-copilot/${w.taskId}`;
  assert.equal(p.seen[0]?.scope, "worktree");
  assert.equal(p.seen[0]?.risk, "low");
  assert.equal(readFileSync(`${tree}/copilot-was-here.txt`, "utf8"), "hello\n");
  // the originating checkout is untouched, and the work is committed on the task's branch
  assert.equal(git(w.repo, "status", "--porcelain"), "");
  assert.equal(git(w.repo, "log", "-1", "--format=%s", `copilot/${w.taskId}`), "copilot: Add the file");
  const [reply] = replies(w);
  assert.equal(reply?.outcome, "completed");
  assert.match(reply?.summary ?? "", /Wrote the file/);
  assert.match(reply?.diff_stat ?? "", /copilot-was-here\.txt/);
  assert.equal(reply?.branch, `copilot/${w.taskId}`);
  assert.equal(reply?.usage.prompts, 1);
  assert.ok((reply?.usage.credits ?? 0) > 0);
  // the request reached the originating session before the reply, in words a v0 peer can show
  const kinds = inbox(w).map((m) => m.kind);
  assert.deepEqual(kinds, ["permission_request", "reply"]);
  assert.match(inbox(w)[0]?.text ?? "", /Only you can answer: \/copilot approve r1/);
  assert.equal(state(w).state, "completed");
  assert.match(audit(w), /"what":"request"[^\n]*copilot-was-here/);
  assert.match(audit(w), /"decision":"approve","decided_by":"command"/);
  // the sidecar left Crosstalk as a peer that has ended
  const record = JSON.parse(readFileSync(`${w.root}/sessions/copilot-${w.taskId}.json`, "utf8")) as { address: string; endedAt?: number };
  assert.equal(record.address, `copilot/${w.taskId}`);
  assert.ok(record.endedAt);
});

test("a request nobody answers is denied when its time runs out", async () => {
  const w = world("no-answer-bbbb");
  handOver(w, "Add the file");
  assert.equal(await runTask(options(w, { permissionTimeoutMs: 600 })), "completed");
  assert.equal(existsSync(`${w.repo}-copilot/${w.taskId}/copilot-was-here.txt`), false);
  assert.match(audit(w), /"decision":"deny","decided_by":"timeout"/);
  assert.match(replies(w)[0]?.summary ?? "", /not allowed/);
  assert.equal(replies(w)[0]?.diff_stat, "");
});

test("a decision file that does not say a person decided is not an answer", async () => {
  const w = world("forged-cccc");
  handOver(w, "Add the file");
  const paths = taskPaths(w.root, w.taskId);
  const forger = setInterval(() => {
    if (existsSync(`${paths.requests}/r1.json`)) {
      writeFileSync(`${paths.decisions}/r1.json`, JSON.stringify({ request_id: "r1", decision: "approve", decided_by: "policy", at: 1 }));
    }
  }, 50);
  await runTask(options(w, { permissionTimeoutMs: 700 }));
  clearInterval(forger);
  assert.equal(existsSync(`${w.repo}-copilot/${w.taskId}/copilot-was-here.txt`), false);
});

test("a tool that runs without asking stops the task for safety", async () => {
  const w = world("breach-dddd");
  handOver(w, "[no-permission] Add the file");
  assert.equal(await runTask(options(w)), "failed");
  assert.match(replies(w)[0]?.summary ?? "", /STOPPED FOR SAFETY\. Copilot ran a write tool with no approval/);
  assert.equal(replies(w)[0]?.outcome, "failed");
  assert.match(audit(w), /"what":"breach"/);
});

test("a write outside the worktree is high risk, cannot be allowed for the task, and is stopped by a deny", async () => {
  const w = world("outside-eeee");
  handOver(w, "[outside] Add the file");
  const p = person(w, () => "deny");
  await runTask(options(w));
  p.stop();
  assert.equal(p.seen[0]?.scope, "outside");
  assert.equal(p.seen[0]?.risk, "high");
  assert.equal(p.seen[0]?.task_grant, null);
  assert.equal(existsSync(`${w.repo}-copilot/outside.txt`), false);
});

test("allow for this task covers the same command in a follow-up, and only the originating session may follow up", async () => {
  const w = world("grant-ffff");
  handOver(w, "[shell] Run the tests");
  const p = person(w, () => "allow_task");
  const sidecarInbox = `${w.root}/inbox/copilot-${w.taskId}`;
  const sender = setInterval(() => {
    if (replies(w).length === 1 && !existsSync(`${sidecarInbox}/2.json`)) {
      writeFileSync(`${sidecarInbox}/1.json`, JSON.stringify({ from: "work/x", fromId: "someone-else", to: "c", sentAt: 1, text: "[no-permission] do this instead" }));
      writeFileSync(`${sidecarInbox}/2.json`, JSON.stringify({ from: "default/app-ab12", fromId: ORIGIN, to: "c", sentAt: 2, text: "[shell] Run them again" }));
    }
  }, 50);
  assert.equal(await runTask(options(w, { idleMs: 3_000 })), "completed");
  clearInterval(sender);
  p.stop();
  assert.equal(p.seen.length, 1); // the second request never reached the person
  assert.equal(p.seen[0]?.command, "npm test -- --watch=false");
  assert.equal(p.seen[0]?.task_grant, 'commands starting "npm test"');
  assert.match(audit(w), /"decision":"approve","decided_by":"policy"/);
  assert.equal(replies(w).length, 2);
  assert.equal(replies(w)[1]?.usage.prompts, 2);
});

test("a follow-up past the task's prompt cap is not run", async () => {
  const w = world("cap-gggg");
  handOver(w, "[quiet] Look around", { max_prompts: 1 });
  const sidecarInbox = `${w.root}/inbox/copilot-${w.taskId}`;
  const sender = setInterval(() => {
    if (replies(w).length === 1) {
      writeFileSync(`${sidecarInbox}/1.json`, JSON.stringify({ from: "default/app-ab12", fromId: ORIGIN, to: "c", sentAt: 2, text: "[quiet] And again" }));
    }
  }, 50);
  await runTask(options(w, { idleMs: 3_000 }));
  clearInterval(sender);
  assert.equal(replies(w).length, 2);
  assert.match(replies(w)[1]?.summary ?? "", /not run: it has used its 1 prompts/);
  assert.equal(replies(w)[1]?.usage.prompts, 1);
});

test("the person's stop ends a running turn as cancelled", async () => {
  const w = world("stop-hhhh");
  handOver(w, "[slow] Take your time");
  setTimeout(() => writeFileSync(taskPaths(w.root, w.taskId).stop, ""), 500);
  assert.equal(await runTask(options(w)), "cancelled");
  assert.equal(replies(w)[0]?.outcome, "cancelled");
});

test("a backend that dies is started once more, then the task fails and says so", async () => {
  const w = world("crash-iiii");
  handOver(w, "[crash] Fall over");
  assert.equal(await runTask(options(w)), "failed");
  assert.match(replies(w)[0]?.summary ?? "", /ended unexpectedly/);
  assert.match(readFileSync(taskPaths(w.root, w.taskId).log, "utf8"), /"event":"restart"/);
});

test("a task holding a secret, or naming a commit the repository lacks, is refused before anything is made", async () => {
  const secret = world("secret-jjjj");
  handOver(secret, `Deploy with ghp_${"a".repeat(36)}`);
  assert.equal(await runTask(options(secret)), "refused");
  assert.match(replies(secret)[0]?.summary ?? "", /looks like a GitHub token/);
  assert.equal(existsSync(`${secret.repo}-copilot`), false);
  const lost = world("lost-kkkk");
  lost.sha = "f".repeat(40);
  handOver(lost, "Add the file");
  assert.equal(await runTask(options(lost)), "refused");
  assert.match(replies(lost)[0]?.summary ?? "", /is not in/);
});

test("the sidecar runs as its own program, with its settings read from Crosstalk's folder", async () => {
  const w = world("cli-llll");
  handOver(w, "[quiet] Look around");
  mkdirSync(`${w.root}/copilot`, { recursive: true });
  writeFileSync(`${w.root}/copilot/config.json`, JSON.stringify({ backendCommand: FAKE, idleMs: 200 }));
  const ran = spawnSync(process.execPath, [MAIN, "run", w.taskId, "--root", w.root], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(replies(w)[0]?.outcome, "completed");
  assert.equal(spawnSync(process.execPath, [MAIN, "run", "../escape", "--root", w.root]).status, 2);
  await pause(10);
});
