// What may leave a session in a handoff: a context of the right shape, and no secrets. Pure.

import { isSha } from "./git.ts";
import { CONTEXT_VERSION, MAX_DIRTY_PATHS, MAX_TOUCHED } from "./types.ts";
import type { SessionContext } from "./types.ts";

// Key and token formats, by the name a person would know them by. Never the match itself.
const SECRETS: readonly (readonly [string, RegExp])[] = [
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["an OpenAI-style API key", /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a credential in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
];

// The kinds of secret found in a text, by name. Empty when there are none.
export function secretsIn(text: string): string[] {
  return SECRETS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const texts = (v: unknown, most: number): string[] => (Array.isArray(v) ? v.filter(isText).slice(0, most) : []);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export type ContextCheck = { ok: true; context: SessionContext } | { ok: false; error: string };

// Rebuilds a context from untrusted JSON, keeping only the fields the type names. Anything else
// a sender added is dropped here, so nothing unlisted travels on.
export function checkContext(value: unknown): ContextCheck {
  if (!isBag(value) || value.context_version !== CONTEXT_VERSION) {
    return { ok: false, error: "the context is missing or of another version" };
  }
  const git = isBag(value.git) ? value.git : {};
  const claude = isBag(value.claude) ? value.claude : {};
  const host = isBag(value.host) ? value.host : {};
  const dirty = isBag(git.dirty) ? git.dirty : {};
  if (!isText(value.cwd) || value.cwd === "" || !isText(git.repo_root) || git.repo_root === "" || !isText(git.main_root) || git.main_root === "") {
    return { ok: false, error: "the context names no folder or repository" };
  }
  if (!isSha(git.head_sha)) {
    return { ok: false, error: "the context names no commit: the repository needs at least one" };
  }
  if (!isText(claude.session_id) || claude.session_id === "") {
    return { ok: false, error: "the context names no session" };
  }
  const context: SessionContext = {
    context_version: CONTEXT_VERSION,
    captured_at: count(value.captured_at),
    cwd: value.cwd,
    git: {
      repo_root: git.repo_root,
      main_root: git.main_root,
      is_worktree: git.is_worktree === true,
      branch: isText(git.branch) ? git.branch : "",
      head_sha: git.head_sha,
      remote: isText(git.remote) ? git.remote : "",
      dirty: { staged: count(dirty.staged), unstaged: count(dirty.unstaged), untracked: count(dirty.untracked), paths: texts(dirty.paths, MAX_DIRTY_PATHS) },
      worktrees: (Array.isArray(git.worktrees) ? git.worktrees : []).filter(isBag).slice(0, 100)
        .map((w) => ({ path: String(w.path ?? ""), branch: String(w.branch ?? ""), head_sha: String(w.head_sha ?? "") })),
    },
    claude: {
      profile: String(claude.profile ?? ""),
      config_dir: String(claude.config_dir ?? ""),
      session_id: claude.session_id,
      transcript_path: String(claude.transcript_path ?? ""),
      title: String(claude.title ?? ""),
      model: String(claude.model ?? ""),
    },
    host: {
      surface: (["desktop-code-tab", "desktop-terminal-panel", "vscode-terminal", "ssh", "terminal"] as const).find((s) => s === host.surface) ?? "terminal",
      emulator: String(host.emulator ?? "unknown"),
      os: (["windows", "macos", "linux", "unknown"] as const).find((o) => o === host.os) ?? "unknown",
      shell: String(host.shell ?? ""),
    },
    instructions: (Array.isArray(value.instructions) ? value.instructions : []).filter(isBag).slice(0, 10)
      .map((f) => ({ path: String(f.path ?? ""), bytes: count(f.bytes) })).filter((f) => f.path !== ""),
    files_touched: texts(value.files_touched, MAX_TOUCHED),
  };
  // A remote URL can carry a password; that is the one field a secret could ride in.
  const found = secretsIn(context.git.remote);
  if (found.length > 0) {
    context.git.remote = "";
  }
  return { ok: true, context };
}

// What Copilot is told about where it works: the few lines of context that help it, as data.
export function contextNote(context: SessionContext): string {
  const lines = [`This task was handed over from branch ${context.git.branch || "(detached)"} at commit ${context.git.head_sha.slice(0, 12)}.`];
  if (context.files_touched.length > 0) {
    lines.push(`Files recently edited there: ${context.files_touched.slice(-20).join(", ")}.`);
  }
  const { staged, unstaged, untracked } = context.git.dirty;
  if (staged + unstaged + untracked > 0) {
    lines.push("That checkout had uncommitted changes, which are not in this worktree.");
  }
  return lines.join("\n");
}
