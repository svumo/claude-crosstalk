// The task's git worktree: made from the originating commit, on its own branch, beside the
// repository. Git is run by argument list, never through a shell.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import { findGit } from "../context/git-exe.ts";

export type GitResult = { code: number; stdout: string; stderr: string };

// Git for Windows on Windows, found once per process (see context/git-exe.ts).
let gitExe: Promise<string> | null = null;

export function gitProgram(): Promise<string> {
  gitExe ??= findGit(
    {
      platform: process.platform,
      path: process.env.PATH ?? process.env.Path ?? "",
      programFiles: [process.env.ProgramFiles ?? "", process.env["ProgramFiles(x86)"] ?? "", process.env.ProgramW6432 ?? ""],
      localAppData: process.env.LOCALAPPDATA ?? "",
    },
    {
      exists: async (path) => existsSync(path),
      version: (path) => new Promise((resolve) => {
        execFile(path, ["--version"], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout)));
      }),
    },
  );
  return gitExe;
}

export async function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  const program = await gitProgram();
  return new Promise((resolve) => {
    execFile(program, ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const slashes = (path: string): string => path.replace(/\\/g, "/");

// Where a repository's Copilot worktrees go: a folder beside it, unless one was set.
export function worktreeRoot(mainRoot: string, configured?: string): string {
  return slashes(configured && configured.trim() !== "" ? configured.trim() : `${dirname(mainRoot)}/${basename(mainRoot)}-copilot`);
}

export type Worktree = { path: string; branch: string };

export async function createWorktree(mainRoot: string, root: string, taskId: string, baseSha: string): Promise<Worktree> {
  // The object's type, asked with no special characters: MSYS2 builds of git (devkitPro's, for
  // one) expand braces in their arguments, so `<sha>^{commit}` reached git as `<sha>^commit`.
  const exists = await git(mainRoot, ["cat-file", "-t", baseSha]);
  if (exists.code !== 0 || exists.stdout.trim() !== "commit") {
    throw new Error(`commit ${baseSha.slice(0, 12)} is not in ${mainRoot}`);
  }
  mkdirSync(root, { recursive: true });
  const tree: Worktree = { path: `${slashes(root)}/${taskId}`, branch: `copilot/${taskId}` };
  const added = await git(mainRoot, ["worktree", "add", "-b", tree.branch, tree.path, baseSha]);
  if (added.code !== 0) {
    throw new Error(`could not make the worktree: ${added.stderr.trim().slice(0, 300)}`);
  }
  return tree;
}

// Where pictures pasted with a task go in its worktree; git ignores the folder, so they stay out of the branch.
export const PICTURES_DIR = ".copilot-pictures";

// Decodes the task's pasted pictures (base64 in `from`) into the worktree. Returns each one's path
// relative to the worktree, for the prompt; a picture that can't be read is left out.
export async function placePictures(tree: Worktree, from: string, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) {
    return [];
  }
  const to = `${tree.path}/${PICTURES_DIR}`;
  mkdirSync(to, { recursive: true });
  const placed: string[] = [];
  for (const name of names) {
    try {
      writeFileSync(`${to}/${name}`, Buffer.from(readFileSync(`${from}/${name}.b64`, "utf8"), "base64"));
      placed.push(`${PICTURES_DIR}/${name}`);
    } catch {
      // Not saved, or unreadable: the task goes on without it.
    }
  }
  // The exclude file is shared by every worktree of the repository; the line only ever names this folder.
  const exclude = (await git(tree.path, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).stdout.trim();
  if (exclude !== "") {
    const line = `/${PICTURES_DIR}/`;
    const had = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!had.split(/\r?\n/).includes(line)) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${had === "" || had.endsWith("\n") ? "" : "\n"}${line}\n`);
    }
  }
  return placed;
}

// What is uncommitted in a checkout, as text to compare before and after a task.
export async function statusText(dir: string): Promise<string> {
  return (await git(dir, ["status", "--porcelain"])).stdout;
}

// Commits what Copilot left uncommitted, so the branch holds the whole task. The repository's own
// commit hooks run; if the commit is refused the work stays in the worktree and the reason is given.
export async function commitLeftovers(tree: Worktree, task: string): Promise<string> {
  if ((await statusText(tree.path)).trim() === "") {
    return "";
  }
  await git(tree.path, ["add", "-A"]);
  const subject = `copilot: ${task.replace(/\s+/g, " ").trim().slice(0, 60)}`;
  const identity = (await git(tree.path, ["config", "user.email"])).stdout.trim() === ""
    ? ["-c", "user.name=Copilot (via Crosstalk)", "-c", "user.email=copilot@crosstalk.invalid"]
    : [];
  const done = await git(tree.path, [...identity, "commit", "-m", subject]);
  return done.code === 0 ? "" : `Copilot's changes are uncommitted in the worktree: ${done.stderr.trim().slice(0, 200) || "the commit was refused"}`;
}

export async function diffStat(mainRoot: string, baseSha: string, branch: string): Promise<string> {
  return (await git(mainRoot, ["diff", "--stat", `${baseSha}...${branch}`])).stdout.trimEnd();
}

const quote = (path: string): string => (/^[A-Za-z0-9_./:\\-]+$/.test(path) ? path : `"${path}"`);

// The commands the person runs to look at, take or throw away the task's work.
export function mergeBackCommands(mainRoot: string, tree: Worktree, baseSha: string): { review: string; merge: string; discard: string } {
  const repo = `git -C ${quote(slashes(mainRoot))}`;
  return {
    review: `${repo} diff ${baseSha.slice(0, 12)}...${tree.branch}`,
    merge: `${repo} merge --no-ff ${tree.branch}`,
    discard: `${repo} worktree remove --force ${quote(tree.path)} && ${repo} branch -D ${tree.branch}`,
  };
}
