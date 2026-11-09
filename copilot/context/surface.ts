// Tells where a session runs from its environment. Pure: the caller reads the variables.

import type { HostContext, Surface } from "./types.ts";

// The variables host detection reads. Only these are ever looked at, and none is passed on.
export const HOST_VARIABLES = [
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_HOST_SESSION_ID", "TERM_PROGRAM", "WT_SESSION", "TMUX", "SSH_CONNECTION", "SSH_TTY",
  "VSCODE_GIT_ASKPASS_NODE", "OS", "OSTYPE", "SHELL", "ComSpec", "PSModulePath", "HOME", "USERPROFILE",
] as const;

export type HostVariables = Partial<Record<(typeof HOST_VARIABLES)[number], string | undefined>>;

const set = (value: string | undefined): boolean => typeof value === "string" && value !== "";

const PROGRAMS: Record<string, string> = {
  apple_terminal: "Terminal.app",
  "iterm.app": "iTerm2",
  wezterm: "WezTerm",
  ghostty: "Ghostty",
  warpterminal: "Warp",
  tmux: "tmux",
};

function emulatorOf(v: HostVariables): string {
  const program = String(v.TERM_PROGRAM ?? "").toLowerCase();
  if (program === "vscode") {
    return /codium/i.test(String(v.VSCODE_GIT_ASKPASS_NODE ?? "")) ? "VSCodium" : "VS Code";
  }
  if (set(v.TMUX)) {
    return "tmux";
  }
  if (set(v.WT_SESSION)) {
    return "Windows Terminal";
  }
  return PROGRAMS[program] ?? (program === "" ? "unknown" : String(v.TERM_PROGRAM));
}

function surfaceOf(v: HostVariables): Surface {
  // The desktop app marks the sessions it runs; a shell in its Terminal panel inherits the
  // app session's id but starts its own Claude Code, whose entrypoint is not the app's.
  if (v.CLAUDE_CODE_ENTRYPOINT === "claude-desktop") {
    return "desktop-code-tab";
  }
  if (set(v.CLAUDE_CODE_HOST_SESSION_ID)) {
    return "desktop-terminal-panel";
  }
  if (set(v.SSH_CONNECTION) || set(v.SSH_TTY)) {
    return "ssh";
  }
  return String(v.TERM_PROGRAM ?? "").toLowerCase() === "vscode" ? "vscode-terminal" : "terminal";
}

function osOf(v: HostVariables): HostContext["os"] {
  if (v.OS === "Windows_NT" || set(v.USERPROFILE)) {
    return "windows";
  }
  const type = String(v.OSTYPE ?? "").toLowerCase();
  if (type.startsWith("darwin") || String(v.HOME ?? "").startsWith("/Users/")) {
    return "macos";
  }
  return type.startsWith("linux") || String(v.HOME ?? "").startsWith("/home/") ? "linux" : "unknown";
}

function shellOf(v: HostVariables, os: HostContext["os"]): string {
  if (set(v.SHELL)) {
    return String(v.SHELL).split("/").pop() ?? "";
  }
  return os === "windows" ? "powershell" : "";
}

export function detectHost(variables: HostVariables): HostContext {
  const os = osOf(variables);
  return { surface: surfaceOf(variables), emulator: emulatorOf(variables), os, shell: shellOf(variables, os) };
}
