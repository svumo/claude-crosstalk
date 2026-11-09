// The Copilot sidecar's entry point: one process for one task.
//
//   node copilot/sidecar/main.ts run <task id> --root <Crosstalk's folder>
//   node copilot/sidecar/main.ts start <task id> --root <Crosstalk's folder>   (starts `run` apart from the caller, and returns)
//
// Settings come from <root>/copilot/config.json. The backend command comes from there too, never
// from the task, so a handoff cannot name a program to run.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { AcpBackend, copilotAcpCommand } from "../backend/acp.ts";
import { isTaskId } from "../protocol/ids.ts";
import { taskPaths } from "../protocol/layout.ts";
import { childEnv } from "./env.ts";
import { privateDir, readJson } from "./files.ts";
import { DEFAULT_CONFIG, runTask } from "./task.ts";
import type { TaskConfig } from "./task.ts";

type Settings = TaskConfig & { backendCommand: string[] };

const positive = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

function readSettings(root: string): Settings {
  const file = readJson(`${root}/copilot/config.json`);
  const saved = (typeof file === "object" && file !== null ? file : {}) as Record<string, unknown>;
  const command = Array.isArray(saved.backendCommand) ? saved.backendCommand.filter((word): word is string => typeof word === "string" && word !== "") : [];
  return {
    model: typeof saved.model === "string" ? saved.model : DEFAULT_CONFIG.model,
    worktreeRoot: typeof saved.worktreeRoot === "string" ? saved.worktreeRoot : DEFAULT_CONFIG.worktreeRoot,
    permissionTimeoutMs: positive(saved.permissionTimeoutMs, DEFAULT_CONFIG.permissionTimeoutMs),
    turnTimeoutMs: positive(saved.turnTimeoutMs, DEFAULT_CONFIG.turnTimeoutMs),
    idleMs: positive(saved.idleMs, DEFAULT_CONFIG.idleMs),
    backendCommand: command,
  };
}

function rootFrom(args: string[]): string {
  const at = args.indexOf("--root");
  const given = at >= 0 ? args[at + 1] : undefined;
  return (given ?? process.env.CLAUDE_CROSSTALK_DIR ?? `${homedir()}/.claude-crosstalk`).replace(/\\/g, "/").replace(/\/+$/, "");
}

async function run(taskId: string, root: string): Promise<number> {
  const settings = readSettings(root);
  const state = await runTask({
    root, taskId, backendName: "acp", config: settings, env: childEnv(process.env),
    makeBackend: (model) => new AcpBackend(settings.backendCommand.length > 0 ? settings.backendCommand : copilotAcpCommand(model || undefined)),
  });
  return state === "completed" ? 0 : 1;
}

// Starts `run` as a process of its own, so it outlives whoever asked: its output goes to the
// task's log, and nothing ties it to the caller's terminal.
function start(taskId: string, root: string): number {
  const paths = taskPaths(root, taskId);
  privateDir(paths.dir);
  const out = openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", taskId, "--root", root], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  process.stdout.write(`${child.pid ?? 0}\n`);
  return 0;
}

async function main(): Promise<number> {
  const [verb, taskId, ...rest] = process.argv.slice(2);
  if ((verb !== "run" && verb !== "start") || !isTaskId(taskId)) {
    process.stderr.write("Usage: main.ts run|start <task id> [--root <folder>]\n");
    return 2;
  }
  const root = rootFrom(rest);
  return verb === "start" ? start(taskId, root) : run(taskId, root);
}

main().then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
