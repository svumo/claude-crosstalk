// The permission policy: how a request is classed, and what "allow for this task" may cover.
// Pure. Nothing here approves anything: a request is either covered by a grant the person gave
// earlier in this task, or it goes to the person.

import type { PermissionAsk } from "../backend/adapter.ts";
import { isInside } from "../context/git.ts";
import type { PermissionRequestBody, ToolKind } from "../protocol/schema.ts";

export type Grant =
  | { kind: "read" | "write"; within: "worktree" }
  | { kind: "shell"; prefix: string }
  | { kind: "network"; host: string };

export type Classified = Pick<PermissionRequestBody, "tool_kind" | "title" | "command" | "paths" | "url" | "scope" | "risk" | "task_grant"> & {
  // The grant "allow for this task" would give, or null when only a single approval is offered.
  grant: Grant | null;
};

// Characters that let one shell line do more than its first command.
const SHELL_JOINS = /[;&|`\n\r<>]|\$\(/;

// The first two words of a command, when the whole line is a single plain command.
export function shellPrefix(command: string): string {
  const line = command.trim();
  if (line === "" || SHELL_JOINS.test(line)) {
    return "";
  }
  return line.split(/\s+/).slice(0, 2).join(" ");
}

export function hostOf(url: string): string {
  const match = /^https?:\/\/([^/?#:@\s]+)(?::\d+)?(?:[/?#]|$)/i.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function fileScope(paths: string[], worktree: string): Classified["scope"] {
  if (paths.length === 0) {
    return "none";
  }
  return paths.every((p) => isInside(p, worktree)) ? "worktree" : "outside";
}

// `paths` are the request's paths already resolved (symbolic links and `..` followed) by the caller.
export function classify(ask: PermissionAsk, paths: string[], worktree: string): Classified {
  const base = { tool_kind: ask.kind, title: ask.title, ...(ask.command ? { command: ask.command } : {}), ...(ask.url ? { url: ask.url } : {}), paths };
  const high = { ...base, risk: "high" as const, task_grant: null, grant: null };
  switch (ask.kind) {
    case "read":
    case "write": {
      const scope = fileScope(paths, worktree);
      // A file request that names no path could touch anything, so it is treated as outside.
      return scope === "worktree"
        ? { ...base, scope, risk: "low", task_grant: `all ${ask.kind}s inside the worktree`, grant: { kind: ask.kind, within: "worktree" } }
        : { ...high, scope: scope === "none" ? "outside" : scope };
    }
    case "shell": {
      const prefix = shellPrefix(ask.command ?? "");
      return prefix === "" ? { ...high, scope: "none" } : { ...high, scope: "none", task_grant: `commands starting "${prefix}"`, grant: { kind: "shell", prefix } };
    }
    case "network": {
      const host = hostOf(ask.url ?? "");
      return host === "" ? { ...high, scope: "none" } : { ...high, scope: "none", task_grant: `requests to ${host}`, grant: { kind: "network", host } };
    }
    case "other":
      return { ...high, scope: "none" };
  }
}

const sameGrant = (a: Grant, b: Grant): boolean => JSON.stringify(a) === JSON.stringify(b);

// Whether a grant given earlier in this task covers this request exactly.
export function isCovered(grants: readonly Grant[], request: Classified): boolean {
  const wanted = request.grant;
  if (wanted === null) {
    return false;
  }
  if (wanted.kind === "shell") {
    const command = (request.command ?? "").trim();
    return grants.some((g) => g.kind === "shell" && shellPrefix(command) !== "" && (command === g.prefix || command.startsWith(`${g.prefix} `)));
  }
  return grants.some((g) => sameGrant(g, wanted));
}

// Tool kinds that change something or reach outside: the ones that must never run unapproved.
export const GATED: readonly ToolKind[] = ["write", "shell", "network", "other"];
