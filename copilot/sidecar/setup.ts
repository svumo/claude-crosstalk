// `/copilot setup`: installs the pinned Copilot SDK into Crosstalk's own folder, then starts it
// once to check the sign-in. Nothing is installed into the plugin or the person's project.
//
// The install runs npm with install scripts off, so the package and its bundled runtime arrive as
// files and run nothing on the way in. The runtime is then only ever started by the sidecar.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SDK_PACKAGE, SDK_VERSION, SdkBackend, sdkEntry, sdkFolder } from "../backend/sdk.ts";
import { childEnv } from "./env.ts";

const INSTALL_TIMEOUT_MS = 240_000;
const OUTPUT_MAX = 4_000;

// The npm command line, run with this Node, so no shell is needed to find npm on Windows. Pure
// apart from looking for npm's script beside this Node.
export function npmCommand(execPath: string, exists: (path: string) => boolean = existsSync): string[] | null {
  const bin = dirname(execPath);
  const scripts = [join(bin, "node_modules", "npm", "bin", "npm-cli.js"), join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const script = scripts.find((path) => exists(path));
  return script ? [execPath, script] : null;
}

// The arguments that install the pinned SDK into `folder`. Pure.
export function installArgs(folder: string): string[] {
  return [
    "install", `${SDK_PACKAGE}@${SDK_VERSION}`, "--prefix", folder,
    "--ignore-scripts", "--save-exact", "--no-audit", "--no-fund", "--no-update-notifier", "--loglevel", "error",
  ];
}

type Ran = { code: number; output: string };

function runCommand(argv: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve) => {
    const [command = "", ...args] = argv;
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_MAX);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

// npm needs PATH and its own cache and proxy settings, which the sidecar's allow-list keeps, but
// no token of the person's.
function installEnv(): Record<string, string> {
  const env = childEnv(process.env);
  for (const name of ["npm_config_cache", "npm_config_registry", "npm_config_proxy", "npm_config_https_proxy", "NPM_CONFIG_REGISTRY"]) {
    const value = process.env[name];
    if (value) {
      env[name] = value;
    }
  }
  return env;
}

// Starts the installed SDK in a throwaway folder to see who it is signed in as.
async function signInCheck(root: string, account: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "crosstalk-copilot-setup-"));
  const backend = new SdkBackend(sdkEntry(root), account);
  try {
    const info = await backend.start({ cwd, env: childEnv(process.env) });
    return `Copilot ${info.version} is signed in${info.account ? ` as ${info.account}` : ""}. Tasks now run on the SDK.`;
  } catch (error) {
    return `The SDK is installed, but it did not start: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await backend.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Returns the lines to show the person, and whether setup worked.
export async function setup(root: string, account: string): Promise<{ ok: boolean; text: string }> {
  const npm = npmCommand(process.execPath);
  if (!npm) {
    return { ok: false, text: "npm was not found beside this Node.js, so the Copilot SDK could not be installed." };
  }
  const folder = sdkFolder(root);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!existsSync(join(folder, "package.json"))) {
    writeFileSync(join(folder, "package.json"), `${JSON.stringify({ name: "crosstalk-copilot-runtime", private: true }, null, 2)}\n`);
  }
  const ran = await runCommand([...npm, ...installArgs(folder)], installEnv());
  if (ran.code !== 0 || !existsSync(sdkEntry(root))) {
    return { ok: false, text: `Installing ${SDK_PACKAGE}@${SDK_VERSION} failed${ran.output.trim() ? `: ${ran.output.trim().slice(-600)}` : "."}` };
  }
  const checked = await signInCheck(root, account);
  return { ok: !checked.startsWith("The SDK is installed, but"), text: `Installed ${SDK_PACKAGE}@${SDK_VERSION} in ${folder}.\n${checked}` };
}
