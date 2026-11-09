// Captures the SessionContext of the session that hands a task over: where it is, what git says,
// and how it is hosted. Taken fresh at every handoff, so a changed folder or branch is never stale.

import { parseStatus, parseWorktrees, STATUS_ARGS, WORKTREE_ARGS } from "../context/git.ts";
import { detectHost } from "../context/surface.ts";
import type { HostVariables } from "../context/surface.ts";
import { CONTEXT_VERSION, INSTRUCTION_FILES, MAX_TOUCHED } from "../context/types.ts";
import type { InstructionFile, SessionContext } from "../context/types.ts";
import type { Engine } from "./engine.ts";

// What Crosstalk already knows about this session.
export type Who = { id: string; profile: string; title: string; configDir: string; transcript: string };

const slashes = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");

async function git($: Engine, cwd: string, args: readonly string[]): Promise<string | null> {
  const ran = await $.process.run(["git", "-C", cwd, ...args], { timeoutMs: 20_000 }).catch(() => null);
  return ran && ran.exitCode === 0 ? ran.stdout : null;
}

async function instructionFiles($: Engine, repoRoot: string): Promise<InstructionFile[]> {
  const found: InstructionFile[] = [];
  for (const path of INSTRUCTION_FILES) {
    const stat = await $.fs.stat(`${repoRoot}/${path}`).catch(() => null);
    if (stat && stat.kind === "file") {
      found.push({ path, bytes: stat.size });
    }
  }
  return found;
}

// Each variable is read by its literal name: the engine lists what a module reads from that.
async function hostVariables($: Engine): Promise<HostVariables> {
  return {
    CLAUDE_CODE_ENTRYPOINT: await $.env.get("CLAUDE_CODE_ENTRYPOINT"),
    CLAUDE_CODE_HOST_SESSION_ID: await $.env.get("CLAUDE_CODE_HOST_SESSION_ID"),
    TERM_PROGRAM: await $.env.get("TERM_PROGRAM"),
    WT_SESSION: await $.env.get("WT_SESSION"),
    TMUX: await $.env.get("TMUX"),
    SSH_CONNECTION: await $.env.get("SSH_CONNECTION"),
    SSH_TTY: await $.env.get("SSH_TTY"),
    VSCODE_GIT_ASKPASS_NODE: await $.env.get("VSCODE_GIT_ASKPASS_NODE"),
    OS: await $.env.get("OS"),
    OSTYPE: await $.env.get("OSTYPE"),
    SHELL: await $.env.get("SHELL"),
    HOME: await $.env.get("HOME"),
    USERPROFILE: await $.env.get("USERPROFILE"),
  };
}

// Paths this session edited, as the repository names them. Ones outside it are left out.
function inRepo(paths: readonly string[], repoRoot: string): string[] {
  const root = `${repoRoot.toLowerCase()}/`;
  return paths.map(slashes).filter((p) => p.toLowerCase().startsWith(root)).map((p) => p.slice(root.length)).slice(-MAX_TOUCHED);
}

export async function captureContext($: Engine, who: Who, touched: readonly string[]): Promise<{ context?: SessionContext; error?: string }> {
  const cwd = slashes(await $.session.cwd());
  const roots = await git($, cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (roots === null) {
    return { error: `Copilot tasks need a git repository, and ${cwd} is not in one.` };
  }
  const [top = "", common = ""] = roots.split(/\r?\n/).map((line) => slashes(line.trim()));
  // The common git folder is <main working tree>/.git, for the main tree and every worktree of it.
  const mainRoot = common.endsWith("/.git") ? common.slice(0, -5) : top;
  const status = parseStatus((await git($, cwd, STATUS_ARGS)) ?? "");
  if (status.head_sha === "") {
    return { error: "This repository has no commit yet, so there is nothing to cut a worktree from. Commit once, then try again." };
  }
  const context: SessionContext = {
    context_version: CONTEXT_VERSION,
    captured_at: await $.clock.now(),
    cwd,
    git: {
      repo_root: top,
      main_root: mainRoot,
      is_worktree: top.toLowerCase() !== mainRoot.toLowerCase(),
      ...status,
      remote: ((await git($, cwd, ["remote", "get-url", "origin"])) ?? "").trim(),
      worktrees: parseWorktrees((await git($, cwd, WORKTREE_ARGS)) ?? "").map((w) => ({ ...w, path: slashes(w.path) })),
    },
    claude: { profile: who.profile, config_dir: slashes(who.configDir), session_id: who.id, transcript_path: who.transcript, title: who.title, model: await $.session.model().catch(() => "") },
    host: detectHost(await hostVariables($)),
    instructions: await instructionFiles($, top),
    files_touched: inRepo(touched, top),
  };
  return { context };
}
