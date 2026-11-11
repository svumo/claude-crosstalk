// The sidecar's file handling: private folders, whole-file writes, and reads that never throw.

import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Makes a folder only this user can use, and checks one that is already there: a real folder
// (not a link), owned by this user, closed to others. Windows keeps a profile folder private by
// its own access lists, and has no owner id to compare, so only the link check runs there.
export function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${path} is not a plain folder`);
  }
  if (typeof process.getuid === "function") {
    if (stat.uid !== process.getuid()) {
      throw new Error(`${path} belongs to another user`);
    }
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(path, 0o700);
    }
  }
}

// Writes a file whole: readers see the old text or the new, never half of either.
export function writeWhole(path: string, text: string): void {
  const partial = `${path}.${process.pid}.part`;
  writeFileSync(partial, text, { mode: 0o600 });
  renameSync(partial, path);
}

export function writeJson(path: string, value: unknown): void {
  writeWhole(path, JSON.stringify(value, null, 2));
}

export function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${line}\n`, { mode: 0o600 });
}

// The JSON a file holds, or null when it is missing, half-written or not JSON.
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function listNames(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

export function remove(path: string): void {
  rmSync(path, { force: true });
}

// A path with every symbolic link and `..` followed, for a file that may not exist yet: the
// nearest folder that does exist is resolved, and the rest is joined on.
export function resolveReal(path: string, base: string): string {
  let head = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) {
        return join(head, ...tail);
      }
      tail.unshift(head.slice(parent.length).replace(/^[\\/]+/, ""));
      head = parent;
    }
  }
}
