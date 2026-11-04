// /crosstalk setup's rules, as pure functions, so tests import them. Setups differ per person, so
// profiles are found several ways and can be corrected by hand. Nothing here keeps or prints a key:
// from a shell file only folder paths come out, and from a settings file only a host name.

const BLOCK_START = "# >>> crosstalk shortcuts >>>";
const BLOCK_END = "# <<< crosstalk shortcuts <<<";
const RESERVED = new Set(["default", "code"]);

export const norm = (path) => String(path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
export const sameFolder = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();
export const tilde = (folder, home) => (norm(folder).toLowerCase().startsWith(`${norm(home).toLowerCase()}/`) ? `~${norm(folder).slice(norm(home).length)}` : norm(folder));

// `setup add "D:\my profiles\work" work` into its words, keeping case and spaces inside quotes.
export function parseWords(args) {
  return [...String(args ?? "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

// A name goes into a folder and a shell function, so it is held to a plain shape.
export function isSafeName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,30}$/.test(String(name ?? "")) && !RESERVED.has(name);
}

// A folder goes between double quotes in a shell file, so nothing that could end them is let in.
export function isSafeFolder(path) {
  const p = String(path ?? "");
  return p.length > 0 && p.length < 260 && !/["`$\n\r]/.test(p);
}

// Does this look like a Claude Code profile? Only its top-level names are read.
const MARKS = new Set(["settings.json", "plugins", "projects", ".credentials.json", ".claude.json", "history.jsonl"]);
export function looksLikeProfile(entries) {
  return entries.some((e) => MARKS.has(e.name));
}

// Home folders worth a look: .claude and .claude-anything, leaving out Crosstalk's own.
export function homeCandidates(entries) {
  return entries
    .filter((e) => (e.kind === "dir" || e.isLink) && /^\.claude(-.+)?$/.test(e.name) && e.name !== ".claude-crosstalk")
    .map((e) => e.name);
}

// CLAUDE_CONFIG_DIR values in a shell file, with the home folder filled in. A value built from any
// other variable is left out, as it can't be known from here.
export function configDirsInShell(text, home) {
  const found = new Map();
  const pattern = /CLAUDE_CONFIG_DIR["']?\s*[=:]\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^"'\s;)`]+))/g;
  const h = norm(home);
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) {
      continue;
    }
    for (const match of line.matchAll(pattern)) {
      let value = (match[1] ?? match[2] ?? match[3])
        .replace(/^~(?=[\\/]|$)/, h)
        .replace(/\$\{?HOME\}?/gi, h)
        .replace(/\$env:(USERPROFILE|HOME)/gi, h)
        .replace(/%USERPROFILE%/gi, h);
      // Git Bash spells C:\ as /c/
      if (/^[A-Za-z]:/.test(h)) {
        value = value.replace(/^\/([A-Za-z])(?=\/)/, (_, drive) => `${drive.toUpperCase()}:`);
      }
      if (!/[$%]/.test(value) && /^([A-Za-z]:)?[\\/]/.test(value)) {
        found.set(norm(value).toLowerCase(), norm(value));
      }
    }
  }
  return [...found.values()];
}

// The file with Crosstalk's own block taken out.
export function withoutBlock(text) {
  return String(text ?? "").replace(blockPattern(), "\n");
}

// Does a person's own launcher, outside Crosstalk's block, open this folder?
export function hasLauncher(text, folder, home) {
  return configDirsInShell(withoutBlock(text), home).some((d) => sameFolder(d, folder));
}

// Is `claude-<name>` already something else in this file?
export function nameTaken(text, name) {
  const escaped = name.replace(/[-]/g, "\\-");
  return new RegExp(`(^|[\\s;])(function\\s+|alias\\s+|Set-Alias\\s+)?claude-${escaped}(\\s*\\(\\)|\\s*=|\\s*\\{|\\s+\\{|\\s)`, "m").test(withoutBlock(text));
}

// Only the host: a provider's URL can carry a key in its path or query.
export function providerHost(settingsText) {
  try {
    const url = JSON.parse(settingsText)?.env?.ANTHROPIC_BASE_URL;
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

export function isInstalled(installedText) {
  try {
    return Object.keys(JSON.parse(installedText)?.plugins ?? {}).some((k) => k.startsWith("crosstalk@"));
  } catch {
    return false;
  }
}

function blockPattern() {
  return new RegExp(`\\r?\\n?${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\r?\\n?`);
}

// `claude-work` for each profile. It sets the folder for that one run and puts things back after.
export function shortcutBlock(kind, profiles) {
  const body = profiles.map(({ name, folder }) => {
    if (kind === "powershell") {
      return `function claude-${name} { $was = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = "${norm(folder).replace(/\//g, "\\")}"; try { claude @args } finally { $env:CLAUDE_CONFIG_DIR = $was } }`;
    }
    return `claude-${name}() { CLAUDE_CONFIG_DIR="${norm(folder)}" claude "$@"; }`;
  });
  return [BLOCK_START, "# Added by /crosstalk setup. Safe to delete.", ...body, BLOCK_END].join("\n");
}

// The file with the block in it, replacing an earlier one, so running setup twice changes nothing.
export function mergeBlock(text, block) {
  const source = String(text ?? "");
  if (blockPattern().test(source)) {
    return source.replace(blockPattern(), () => `\n${block}\n`);
  }
  if (source === "") {
    return `${block}\n`;
  }
  return `${source}${source.endsWith("\n") ? "" : "\n"}\n${block}\n`;
}

// The shortcuts already in a file's block, as { name, folder }, so a later run keeps them.
export function shortcutsIn(text) {
  const block = blockPattern().exec(String(text ?? ""));
  if (!block) {
    return [];
  }
  const out = [];
  for (const line of block[0].split(/\r?\n/)) {
    const m = /claude-([a-z0-9_-]+)(?:\(\))?\s*\{.*CLAUDE_CONFIG_DIR\s*=\s*"([^"]+)"/.exec(line);
    if (m) {
      out.push({ name: m[1], folder: norm(m[2]) });
    }
  }
  return out;
}

// What the setup file calls this folder.
export function savedName(setup, folder) {
  const key = Object.keys(setup?.names ?? {}).find((k) => sameFolder(k, folder));
  return key ? setup.names[key] : "";
}

// A file a shell reads that can't be written safely, as an editor may have saved it as UTF-16.
export function isUnreadable(text) {
  return /[\0\uFFFD]/.test(String(text ?? ""));
}

// What each profile needs. `targets` are the shell files shortcuts can go in; `shells` all those read.
export function planSetup({ profiles, shells, targets, home }) {
  const seen = new Map();
  const rows = profiles.map((p) => {
    const row = { ...p, start: "", isNewShortcut: false, note: "" };
    const twin = seen.get(p.name);
    seen.set(p.name, p.folder);
    const existing = shells.flatMap((s) => shortcutsIn(s.text)).find((s) => sameFolder(s.folder, p.folder));
    if (sameFolder(p.folder, `${home}/.claude`)) {
      row.start = "claude";
    } else if (existing) {
      row.start = `claude-${existing.name}`;
    } else if (shells.some((s) => hasLauncher(s.text, p.folder, home))) {
      row.start = "your own command";
    } else if (twin) {
      row.note = `It has the same name as ${tilde(twin, home)}. Give one a new name.`;
    } else if (!isSafeName(p.name) || !isSafeFolder(p.folder)) {
      row.note = "Its name or folder can't go in a shortcut, so it stays as it is.";
    } else if (shells.some((s) => nameTaken(s.text, p.name))) {
      row.note = `claude-${p.name} is already something else in your shell file. Give this profile a new name.`;
    } else {
      row.start = `claude-${p.name}`;
      row.isNewShortcut = targets.length > 0;
    }
    if (twin && !row.note) {
      row.note = `It has the same name as ${tilde(twin, home)}. Give one a new name.`;
    }
    return row;
  });
  return { rows, toInstall: rows.filter((r) => !r.installed), shortcuts: rows.filter((r) => r.isNewShortcut) };
}

const HELP = [
  "Not right?",
  "  /crosstalk setup add <folder> [name]   a profile it missed, kept in any folder",
  "  /crosstalk setup skip <name>           leave one out",
  "  /crosstalk setup name <name> <new>     change a name",
  "  /crosstalk add <name>                  make a new profile",
];

export function previewText(plan, targets, problems, home) {
  const lines = [`Crosstalk found ${plan.rows.length} Claude Code profile${plan.rows.length === 1 ? "" : "s"}:`, ""];
  for (const r of plan.rows) {
    const bits = [`found in ${r.how.join(" and ")}`];
    if (r.provider) {
      bits.push(`uses ${r.provider}`);
    }
    bits.push(r.installed ? "Crosstalk installed" : "needs Crosstalk");
    if (r.start) {
      bits.push(`start with ${r.start}${r.isNewShortcut ? " (new)" : ""}`);
    }
    lines.push(`  ${r.name}: ${tilde(r.folder, home)}`, `    ${bits.join(", ")}`);
    if (r.note) {
      lines.push(`    ${r.note}`);
    }
  }
  lines.push("");
  lines.push(...problems, ...(problems.length ? [""] : []));
  if (plan.toInstall.length || plan.shortcuts.length) {
    lines.push("/crosstalk setup yes will:");
    if (plan.toInstall.length) {
      lines.push(`  - install Crosstalk on ${plan.toInstall.map((r) => r.name).join(", ")}`);
    }
    if (plan.shortcuts.length) {
      lines.push(`  - add ${plan.shortcuts.map((r) => `claude-${r.name}`).join(", ")} to ${targets.map((t) => tilde(t.path, home)).join(" and ")}, with a backup beside it`);
    }
    lines.push("Nothing has changed yet.", "");
  } else if (plan.rows.length === 1) {
    lines.push("This is the only profile. /crosstalk add <name> makes another, with its own login.", "");
  } else {
    lines.push("All set: nothing to do.", "");
  }
  lines.push(...HELP);
  return lines.join("\n");
}

// The line to run by hand when Crosstalk can't do it itself.
export function manualInstall(folder, marketplace, isWindows) {
  const command = `claude plugin install crosstalk --marketplace ${marketplace}`;
  return isWindows ? `$env:CLAUDE_CONFIG_DIR = "${norm(folder).replace(/\//g, "\\")}"; ${command}` : `CLAUDE_CONFIG_DIR="${norm(folder)}" ${command}`;
}
