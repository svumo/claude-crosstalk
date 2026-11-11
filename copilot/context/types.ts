// SessionContext: where and how the originating Claude session runs, attached to every handoff.
// An allow-list by construction: paths, names and counts, never file contents, transcript text or
// environment values.

export const CONTEXT_VERSION = 1;

export type Surface = "desktop-code-tab" | "desktop-terminal-panel" | "vscode-terminal" | "ssh" | "terminal";

export type HostContext = {
  surface: Surface;
  // The terminal program, when one can be told: "Windows Terminal", "iTerm2", "tmux", ...
  emulator: string;
  os: "windows" | "macos" | "linux" | "unknown";
  shell: string;
};

export type GitContext = {
  repo_root: string;
  // The main working tree's root: the same as repo_root unless the session is in a worktree.
  main_root: string;
  is_worktree: boolean;
  branch: string;
  head_sha: string;
  remote: string;
  dirty: { staged: number; unstaged: number; untracked: number; paths: string[] };
  worktrees: { path: string; branch: string; head_sha: string }[];
};

export type InstructionFile = { path: string; bytes: number };

export type SessionContext = {
  context_version: typeof CONTEXT_VERSION;
  captured_at: number;
  cwd: string;
  git: GitContext;
  claude: { profile: string; config_dir: string; session_id: string; transcript_path: string; title: string; model: string };
  host: HostContext;
  instructions: InstructionFile[];
  // Repo-relative paths this session edited, newest last.
  files_touched: string[];
};

export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", ".github/copilot-instructions.md"] as const;
export const MAX_TOUCHED = 200;
export const MAX_DIRTY_PATHS = 50;
// A context older than this at launch is captured again.
export const STALE_MS = 10 * 60_000;
