// Pictures pasted with /copilot: decoded into the task's worktree, kept out of its branch, and
// refused in a handoff when a name could leave the attachments folder.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isImageName, makeEnvelope, parseEnvelope } from "../../copilot/protocol/schema.ts";
import type { TaskBody } from "../../copilot/protocol/schema.ts";
import { commitLeftovers, createWorktree, PICTURES_DIR, placePictures, statusText } from "../../copilot/sidecar/worktree.ts";

const slashes = (path: string): string => path.replace(/\\/g, "/");
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("pasted pictures land in the worktree, git ignores them, and the task's commit leaves them out", async () => {
  const base = slashes(realpathSync(mkdtempSync(join(tmpdir(), "xt-pics-"))));
  const repo = `${base}/app`;
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test");
  writeFileSync(`${repo}/README.md`, "app\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const tree = await createWorktree(repo, `${base}/trees`, "t1", git(repo, "rev-parse", "HEAD"));
  const from = `${base}/attachments`;
  mkdirSync(from);
  writeFileSync(`${from}/1.png.b64`, PNG);

  const placed = await placePictures(tree, from, ["1.png", "2.png"]);
  assert.deepEqual(placed, [`${PICTURES_DIR}/1.png`], "a picture with no saved file is left out");
  assert.deepEqual(readFileSync(`${tree.path}/${PICTURES_DIR}/1.png`), Buffer.from(PNG, "base64"));
  assert.equal(await statusText(tree.path), "");

  // Placing again doesn't add the exclude line twice.
  await placePictures(tree, from, ["1.png"]);
  const exclude = readFileSync(git(tree.path, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"), "utf8");
  assert.equal(exclude.split(/\r?\n/).filter((l) => l === `/${PICTURES_DIR}/`).length, 1);

  writeFileSync(`${tree.path}/done.txt`, "done\n");
  assert.equal(await commitLeftovers(tree, "a task"), "");
  assert.equal(git(tree.path, "show", "--name-only", "--format=", "HEAD"), "done.txt");
});

test("a handoff's picture names are plain numbered image files", () => {
  for (const good of ["1.png", "12.jpg", "3.webp", "4.gif"]) {
    assert.ok(isImageName(good), good);
  }
  for (const bad of ["../1.png", "1.png/../x", "a.png", "1.exe", "", "1.PNG", "1234.png"]) {
    assert.ok(!isImageName(bad), bad);
  }
  const envelope = (images: unknown) => makeEnvelope<TaskBody>({
    id: "m1", thread_id: "t1", from: "a", fromId: "a", to: "copilot/t1", sent_at: 1, kind: "task",
    body: { task_id: "t1", task: "look", images: images as string[] }, text: "look",
  });
  assert.ok(parseEnvelope(JSON.parse(JSON.stringify(envelope(["1.png"])))).ok);
  assert.ok(!parseEnvelope(JSON.parse(JSON.stringify(envelope(["../../evil.png"])))).ok);
});
