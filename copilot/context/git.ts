// Reads git's machine output. Pure: the caller runs git and hands the text over.

import { MAX_DIRTY_PATHS } from "./types.ts";
import type { GitContext } from "./types.ts";

export const STATUS_ARGS = ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"] as const;
export const WORKTREE_ARGS = ["worktree", "list", "--porcelain"] as const;

export type Status = Pick<GitContext, "branch" | "head_sha" | "dirty">;

// The path of a changed-entry line: after 8 fields for an ordinary change, 9 for a rename (whose
// path ends at a tab), 10 for an unmerged one.
function pathAfter(line: string, fields: number): string {
  let at = 0;
  for (let i = 0; i < fields; i += 1) {
    at = line.indexOf(" ", at) + 1;
    if (at === 0) {
      return "";
    }
  }
  return line.slice(at).split("\t")[0] ?? "";
}

// `git status --porcelain=v2 --branch`: the branch, the commit, and what is uncommitted.
export function parseStatus(stdout: string): Status {
  const status: Status = { branch: "", head_sha: "", dirty: { staged: 0, unstaged: 0, untracked: 0, paths: [] } };
  const paths = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13).trim();
      status.head_sha = oid === "(initial)" ? "" : oid;
    } else if (line.startsWith("# branch.head ")) {
      const head = line.slice(14).trim();
      status.branch = head === "(detached)" ? "" : head;
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const xy = line.slice(2, 4);
      status.dirty.staged += xy[0] === "." ? 0 : 1;
      status.dirty.unstaged += xy[1] === "." ? 0 : 1;
      paths.add(pathAfter(line, line[0] === "1" ? 8 : line[0] === "2" ? 9 : 10));
    } else if (line.startsWith("? ")) {
      status.dirty.untracked += 1;
      paths.add(line.slice(2));
    }
  }
  status.dirty.paths = [...paths].filter(Boolean).slice(0, MAX_DIRTY_PATHS);
  return status;
}

export const isDirty = (status: Status): boolean => status.dirty.staged + status.dirty.unstaged + status.dirty.untracked > 0;

// `git worktree list --porcelain`: the main working tree first, then the others.
export function parseWorktrees(stdout: string): GitContext["worktrees"] {
  const trees: GitContext["worktrees"] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const tree = { path: "", branch: "", head_sha: "" };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        tree.path = line.slice(9);
      } else if (line.startsWith("HEAD ")) {
        tree.head_sha = line.slice(5);
      } else if (line.startsWith("branch ")) {
        tree.branch = line.slice(7).replace(/^refs\/heads\//, "");
      }
    }
    if (tree.path !== "") {
      trees.push(tree);
    }
  }
  return trees;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const isSha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);

// A path as one spelling, for comparing: forward slashes, no trailing slash, case folded on a
// Windows drive path.
export function pathKey(path: string): string {
  const tidy = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(tidy) ? tidy.toLowerCase() : tidy;
}

// Whether `path` is `root` or inside it, by spelling. The sidecar resolves both first.
export function isInside(path: string, root: string): boolean {
  const p = pathKey(path);
  const r = pathKey(root);
  return r !== "" && (p === r || p.startsWith(`${r}/`));
}
