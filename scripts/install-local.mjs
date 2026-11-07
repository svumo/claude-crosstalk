#!/usr/bin/env node
// Installs this repo's committed code on every Claude Code profile on this computer that has
// Crosstalk, so they all run what's here without copying anything by hand.
//
//   node scripts/install-local.mjs            update every profile that has Crosstalk
//   node scripts/install-local.mjs --dry-run  only say what it would do
//
// A profile is a home folder named .claude or .claude-<name> whose plugins record lists Crosstalk.
// Each one is updated from the marketplace it installed Crosstalk from:
//   - a folder marketplace (such as one in ~/.claude/mod-sources): the committed files are copied
//     into that marketplace's crosstalk folder first, then the profile updates from it;
//   - a GitHub marketplace: the profile updates from GitHub, so push first.
// Only committed files are copied (HEAD, as git has them); uncommitted changes are left out.
// Claude Code only updates when the version in .claude-plugin/plugin.json is new to that
// profile, so bump it to see a change.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = "crosstalk";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isDry = process.argv.includes("--dry-run");
const isWindows = process.platform === "win32";

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

function git(args, asText = true) {
  const r = spawnSync("git", args, { cwd: repo, encoding: asText ? "utf8" : "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  }
  return r.stdout;
}

// `claude` is a .cmd on some Windows installs, which only a shell starts. The arguments here are
// plain words, so passing them through the shell is safe.
function claude(configDir, args) {
  const r = spawnSync("claude", args, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    encoding: "utf8",
    shell: isWindows,
    timeout: 180_000,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// Every profile with Crosstalk, and the marketplace it came from.
function findProfiles() {
  const home = homedir();
  const found = [];
  for (const name of readdirSync(home)) {
    if (!/^\.claude(-.+)?$/.test(name) || name === ".claude-crosstalk") {
      continue;
    }
    const folder = join(home, name);
    const installed = readJson(join(folder, "plugins", "installed_plugins.json"));
    const id = Object.keys(installed?.plugins ?? {}).find((k) => k.split("@")[0] === PLUGIN);
    if (!id) {
      continue;
    }
    const marketplace = id.split("@")[1];
    const known = readJson(join(folder, "plugins", "known_marketplaces.json")) ?? {};
    found.push({
      name: name === ".claude" ? "default" : name.replace(/^\.claude-/, ""),
      folder,
      id,
      marketplace,
      source: known[marketplace]?.source ?? null,
      version: installed.plugins[id]?.[0]?.version ?? "?",
    });
  }
  return found;
}

// Where a folder marketplace keeps Crosstalk's files.
function pluginFolder(source) {
  const root = source.path;
  const listing = readJson(join(root, ".claude-plugin", "marketplace.json"));
  const entry = listing?.plugins?.find((p) => p.name === PLUGIN);
  return typeof entry?.source === "string" ? resolve(root, entry.source) : null;
}

// The committed files, written over what's in `target`. Files there that git doesn't have are left.
function copyCommitted(target) {
  const paths = git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  for (const path of paths) {
    const to = join(target, path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, git(["show", `HEAD:${path}`], false));
  }
  const extra = [];
  const walk = (dir, rel = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(join(dir, e.name), r);
      } else if (!paths.includes(r)) {
        extra.push(r);
      }
    }
  };
  walk(target);
  return { count: paths.length, extra };
}

function main() {
  const version = readJson(join(repo, ".claude-plugin", "plugin.json"))?.version ?? "?";
  const head = git(["rev-parse", "--short", "HEAD"]).trim();
  const dirty = git(["status", "--porcelain"]).trim() !== "";
  console.log(`Crosstalk ${version} at ${head}${dirty ? " (uncommitted changes are left out)" : ""}${isDry ? ", dry run" : ""}\n`);

  const profiles = findProfiles();
  if (profiles.length === 0) {
    console.log("No profile here has Crosstalk. Install it first: claude plugin install crosstalk --marketplace svumo/claude-crosstalk");
    return 1;
  }

  // Each folder marketplace is filled once, however many profiles use it.
  const filled = new Set();
  for (const p of profiles) {
    if (p.source?.source !== "directory") {
      continue;
    }
    const target = pluginFolder(p.source);
    if (!target) {
      console.log(`${p.marketplace}: its marketplace.json doesn't list ${PLUGIN}, so nothing is copied there.`);
      continue;
    }
    if (filled.has(target.toLowerCase()) || same(target, repo)) {
      continue;
    }
    filled.add(target.toLowerCase());
    if (isDry) {
      console.log(`Would copy the committed files to ${target}`);
      continue;
    }
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }
    const { count, extra } = copyCommitted(target);
    console.log(`Copied ${count} files to ${target}${extra.length ? `. Not in git, left there: ${extra.join(", ")}` : ""}`);
  }

  let failures = 0;
  for (const p of profiles) {
    const from = p.source?.source === "directory" ? "folder" : p.source?.source === "github" ? `GitHub ${p.source.repo}` : "unknown";
    if (isDry) {
      console.log(`${p.name}: has ${p.version} from ${p.marketplace} (${from}); would update it`);
      continue;
    }
    const market = claude(p.folder, ["plugin", "marketplace", "update", p.marketplace]);
    const update = claude(p.folder, ["plugin", "update", p.id]);
    const now = readJson(join(p.folder, "plugins", "installed_plugins.json"))?.plugins?.[p.id]?.[0]?.version ?? "?";
    const ok = market.ok && update.ok;
    failures += ok ? 0 : 1;
    const unchanged = ok && now === p.version ? `; already ${now}, so bump the version in plugin.json to load new code` : "";
    console.log(`${p.name}: ${p.version} -> ${now} (from ${p.marketplace}, ${from})${unchanged}${ok ? "" : `\n  ${(market.ok ? update : market).out.split("\n").slice(-2).join("\n  ")}`}`);
  }
  if (!isDry) {
    console.log("\nRunning sessions load the new version when they're restarted.");
    if (profiles.some((p) => p.source?.source === "github")) {
      console.log("Profiles on a GitHub marketplace get what's pushed, not what's only committed here.");
    }
  }
  return failures ? 1 : 0;
}

process.exitCode = main();
