// The sidecar's settings, from <root>/copilot/config.json, and which backend follows from them.
// The backend comes from here and never from a task, so a handoff cannot name a program to run.

import { isMode } from "../protocol/schema.ts";
import { readJson } from "./files.ts";
import { DEFAULT_CONFIG } from "./task.ts";
import type { TaskConfig } from "./task.ts";

// `backend`: "sdk", "acp", or "auto" (the SDK when `/copilot setup` has installed it, else ACP).
// `backendCommand` names another ACP agent's command line, and implies ACP.
// `account`: the only GitHub login Copilot may be signed in as (checked on the SDK backend).
export type Settings = TaskConfig & { backend: "auto" | "sdk" | "acp"; backendCommand: string[]; account: string };

const positive = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

export function readSettings(root: string): Settings {
  const file = readJson(`${root}/copilot/config.json`);
  const saved = (typeof file === "object" && file !== null ? file : {}) as Record<string, unknown>;
  const command = Array.isArray(saved.backendCommand) ? saved.backendCommand.filter((word): word is string => typeof word === "string" && word !== "") : [];
  return {
    model: typeof saved.model === "string" ? saved.model : DEFAULT_CONFIG.model,
    mode: isMode(saved.mode) ? saved.mode : DEFAULT_CONFIG.mode,
    worktreeRoot: typeof saved.worktreeRoot === "string" ? saved.worktreeRoot : DEFAULT_CONFIG.worktreeRoot,
    permissionTimeoutMs: positive(saved.permissionTimeoutMs, DEFAULT_CONFIG.permissionTimeoutMs),
    turnTimeoutMs: positive(saved.turnTimeoutMs, DEFAULT_CONFIG.turnTimeoutMs),
    idleMs: positive(saved.idleMs, DEFAULT_CONFIG.idleMs),
    backend: saved.backend === "sdk" || saved.backend === "acp" ? saved.backend : "auto",
    backendCommand: command,
    account: typeof saved.account === "string" ? saved.account : "",
  };
}

// Which backend a task runs on, from the settings and whether the SDK is installed.
export function chooseBackend(settings: Pick<Settings, "backend" | "backendCommand">, hasSdk: boolean): "sdk" | "acp" {
  if (settings.backendCommand.length > 0 || settings.backend === "acp") {
    return "acp";
  }
  return settings.backend === "sdk" || hasSdk ? "sdk" : "acp";
}
