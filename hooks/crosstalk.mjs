// Crosstalk: Claude Code sessions message each other, across profiles and AI providers.
//
// Built-in messaging only reaches sessions of one profile, as each profile keeps its own list.
// This uses a folder all of them can read, ~/.claude-crosstalk:
//   sessions/<id>.json          who is running, rewritten every 15 seconds
//   inbox/<id>/<time>-<x>.json  a message for that session; kept, as a record
//   inbox/<id>/_delivered.json  which of them that session has had
//
// A message reaches the model one of two ways. Idle: it starts a turn. Mid-turn: as a row after a
// step's last tool result, which the next request carries. A turn with no tools left to run gets
// it when it ends. A limit on wake-ups stops two sessions replying to each other for ever.
//
// The host reads on(...) and $.noun.method(...) from source, so they are spelled literally, and
// helpers that take $ are top-level functions.

import {
  addressOf, frameMessages, isLive, MAX_TEXT, mayWake, messageFileName,
  pendingNames, profileName, resolveTarget, showMessages, toolResultCount, toolUseCount,
} from "./core.mjs";
import {
  configDirsInShell, homeCandidates, isInstalled, isSafeFolder, isSafeName, isUnreadable, looksLikeProfile,
  manualInstall, mergeBlock, norm, parseWords, planSetup, previewText, providerHost, sameFolder, savedName,
  shortcutBlock, shortcutsIn, tilde, withoutBlock,
} from "./setup.mjs";

const POLL_MS = 3_000;
const BEAT_MS = 15_000;
const BAD_TRIES = 20;
const PRUNE_DAYS = 7;
const SEND = "mcp__crosstalk__send";
const LIST = "mcp__crosstalk__list";
const MARKETPLACE = "svumo/claude-crosstalk";

let limit = 25;
// { id, profile, address, cwd, startedAt }, set at session.start.
let me = null;
let root = null;
let isOff = false;
let isBusy = false;
let isPolling = false;
let wakes = 0;
let warned = false;
let delivered = new Set();
let tries = new Map();
// A response's tool calls still waiting for their results.
let openTools = 0;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    try {
      await startUp($);
    } catch (error) {
      me = null;
      $.ui.toast(`Crosstalk could not start: ${String(error).slice(0, 120)}`);
    }
    return result;
  });

  on("session.end", async ($, e, next) => {
    if (me) {
      await beat($, { endedAt: await $.clock.now() }).catch(() => {});
    }
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (e.origin?.kind === "composer" || e.origin?.kind === "bridge") {
      wakes = 0; // the person is here
      warned = false;
    }
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) {
      isBusy = true;
      openTools = 0;
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      isBusy = false;
      openTools = 0;
      void poll($);
    }
    return result;
  });

  // Mid-turn delivery: after a response's last tool result the loop always asks the model again.
  // The new row is started but not awaited: this row's own append has to finish first.
  on("session.append", async ($, e, next) => {
    const stored = await next(e);
    if (e.agentId !== undefined || !me || isOff) {
      return stored;
    }
    if (e.door === "response") {
      openTools += toolUseCount(e.message?.content);
    } else if (e.door === "tool-result" && openTools > 0) {
      openTools = Math.max(0, openTools - toolResultCount(e.message?.content));
      if (openTools === 0 && !isPolling) {
        isPolling = true;
        try {
          const batch = await readInbox($);
          if (batch.length > 0) {
            noteArrival($, batch);
            const text = frameMessages(batch);
            await markDelivered($, batch);
            void $.session.append({ message: { type: "user", content: [{ type: "text", text }] } })
              .catch(() => unmark($, batch));
          }
        } finally {
          isPolling = false;
        }
      }
    }
    return stored;
  });

  on("tool.call", { tool: LIST }, async ($) => {
    if (!me) {
      return notReady();
    }
    const now = await $.clock.now();
    const others = (await readSessions($)).filter((r) => r.id !== me.id && isLive(r, now));
    const lines = others.map((r) => `${r.address} (folder ${r.cwd})`);
    return { result: `You are ${me.address}.\n${lines.length ? `Also running:\n${lines.join("\n")}` : "No other session is running Crosstalk."}` };
  });

  on("tool.call", { tool: SEND }, async ($, e) => {
    if (!me) {
      return notReady();
    }
    const text = String(e.text ?? "");
    if (text.trim() === "") {
      return failed("The message is empty.");
    }
    if (text.length > MAX_TEXT) {
      return failed(`The message is ${text.length} characters; the most is ${MAX_TEXT}. Write it to a file and send the path.`);
    }
    const now = await $.clock.now();
    const found = resolveTarget(e.to, await readSessions($), me.id, now);
    if (found.error) {
      return failed(found.error);
    }
    const name = messageFileName(now, Math.random().toString(36).slice(2, 10));
    await $.fs.write(`${root}/inbox/${found.record.id}/${name}`, JSON.stringify({ from: me.address, fromId: me.id, to: found.record.address, sentAt: now, text }));
    return { result: `Sent to ${found.record.address}. It arrives within a few seconds, or after the step that session is on.` };
  });

  on("command.run", { command: "crosstalk" }, async ($, e) => {
    const words = parseWords(e.args);
    const word = String(words[0] ?? "").toLowerCase();
    if (word === "off" || word === "on") {
      isOff = word === "off";
      return { text: isOff ? "Crosstalk off: messages wait until you turn it on." : "Crosstalk on." };
    }
    if (!me) {
      return { text: "Crosstalk did not start in this session." };
    }
    if (word === "setup") {
      return { text: await setupCommand($, words.slice(1)) };
    }
    if (word === "add") {
      return { text: await addProfile($, String(words[1] ?? "").toLowerCase()) };
    }
    const now = await $.clock.now();
    const others = (await readSessions($)).filter((r) => r.id !== me.id && isLive(r, now)).map((r) => r.address);
    const hint = others.length ? "" : " /crosstalk setup connects your other profiles.";
    return { text: `You are ${me.address}${isOff ? " (off)" : ""}. Others running: ${others.join(", ") || "none"}. Wake-ups since you last typed: ${wakes} of ${limit}.${hint}` };
  });
}

// The person's computer, as setup needs it. CLAUDE_CROSSTALK_HOME stands in for the home folder, so
// tests never touch real shell files or profiles.
async function computer($) {
  const seam = await $.env.get("CLAUDE_CROSSTALK_HOME");
  const windowsHome = await $.env.get("USERPROFILE");
  const home = norm(seam || windowsHome || (await $.env.get("HOME")));
  const isWindows = (await $.env.get("OS")) === "Windows_NT" || Boolean(windowsHome);
  const config = await $.env.get("CLAUDE_CONFIG_DIR");
  return {
    home, isWindows, isSeam: Boolean(seam),
    current: norm(config || `${home}/.claude`),
    shellName: String((await $.env.get("SHELL")) ?? ""),
    marketplace: (await $.env.get("CLAUDE_CROSSTALK_MARKETPLACE")) || MARKETPLACE,
  };
}

async function readText($, path) {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}

async function listFolder($, path) {
  try {
    return await $.fs.list(path);
  } catch {
    return null;
  }
}

// Where each PowerShell keeps its profile, and whether it may run it: writing one where scripts are
// off would put an error on every new window, so that case is told, not written.
async function powerShellProfiles($, pc) {
  if (pc.isSeam) {
    return [{ path: `${pc.home}/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`, policy: "RemoteSigned" }];
  }
  const found = [];
  for (const exe of ["pwsh", "powershell"]) {
    try {
      const { exitCode, stdout } = await $.process.run([exe, "-NoProfile", "-NonInteractive", "-Command", "$PROFILE; Get-ExecutionPolicy"], { timeoutMs: 20_000 });
      const [path, policy] = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (exitCode === 0 && path) {
        found.push({ path: norm(path), policy });
      }
    } catch {
      // that one isn't installed
    }
  }
  return found;
}

// Every shell file worth reading for launchers, and which of them shortcuts can go in.
async function readShells($, pc) {
  const shells = [];
  const problems = [];
  const targets = [];
  const add = async (path, kind, isTarget, policy) => {
    const text = await readText($, path);
    const shell = { path, kind, text: text ?? "" };
    if (text !== null && !isUnreadable(text)) {
      shells.push(shell);
    }
    if (!isTarget) {
      return;
    }
    if (text !== null && isUnreadable(text)) {
      problems.push(`${tilde(path, pc.home)} isn't saved as UTF-8, so Crosstalk leaves it alone and adds no shortcuts there.`);
    } else if (policy === "Restricted" || policy === "AllSigned") {
      problems.push(`PowerShell won't run its profile here (policy ${policy}), so no shortcuts go in ${tilde(path, pc.home)}. To allow it, run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`);
    } else {
      targets.push(shell);
    }
  };
  if (pc.isWindows) {
    for (const p of await powerShellProfiles($, pc)) {
      await add(p.path, "powershell", true, p.policy);
    }
  }
  const posix = pc.isWindows
    ? ((await readText($, `${pc.home}/.bashrc`)) !== null ? ".bashrc" : "")
    : pc.shellName.endsWith("zsh") ? ".zshrc" : pc.shellName.endsWith("bash") ? ".bashrc" : "";
  if (posix) {
    await add(`${pc.home}/${posix}`, "posix", true);
  }
  for (const name of [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile"]) {
    if (name !== posix) {
      await add(`${pc.home}/${name}`, "posix", false);
    }
  }
  return { shells, targets, problems };
}

// Setups differ, so a profile is found any of four ways, then corrected from the setup file.
async function findProfiles($, pc, setup, shells) {
  const found = new Map();
  const note = (folder, how) => {
    const key = norm(folder).toLowerCase();
    const entry = found.get(key) ?? { folder: norm(folder), how: [] };
    entry.how = entry.how.includes(how) ? entry.how : [...entry.how, how];
    found.set(key, entry);
  };
  note(pc.current, "this session");
  for (const name of homeCandidates((await listFolder($, pc.home)) ?? [])) {
    const inside = await listFolder($, `${pc.home}/${name}`);
    if (inside && looksLikeProfile(inside)) {
      note(`${pc.home}/${name}`, "your home folder");
    }
  }
  for (const shell of shells) {
    for (const folder of configDirsInShell(withoutBlock(shell.text), pc.home)) {
      if (await listFolder($, folder)) {
        note(folder, shell.kind === "powershell" ? "your PowerShell profile" : `your ${shell.path.split("/").pop()}`);
      }
    }
    for (const { folder } of shortcutsIn(shell.text)) {
      if (await listFolder($, folder)) {
        note(folder, "a shortcut Crosstalk added");
      }
    }
  }
  for (const folder of setup.folders ?? []) {
    note(folder, "your list");
  }
  const skipped = (setup.skip ?? []).map((f) => norm(f).toLowerCase());
  const profiles = [...found.values()].filter((p) => !skipped.includes(p.folder.toLowerCase()) || sameFolder(p.folder, pc.current));
  return Promise.all(profiles.map(async (p) => {
    const isCurrent = sameFolder(p.folder, pc.current);
    return {
      ...p,
      name: isCurrent ? me.profile : savedName(setup, p.folder) || profileName(undefined, p.folder),
      provider: providerHost((await readText($, `${p.folder}/settings.json`)) ?? ""),
      installed: isInstalled((await readText($, `${p.folder}/plugins/installed_plugins.json`)) ?? ""),
    };
  }));
}

async function survey($, pc, setup) {
  const { shells, targets, problems } = await readShells($, pc);
  const profiles = await findProfiles($, pc, setup, shells);
  return { shells, targets, problems, profiles, plan: planSetup({ profiles, shells, targets, home: pc.home }) };
}

// Install the plugin on a profile. On Windows, `claude` may be a .cmd that only cmd.exe can start.
async function installOn($, pc, folder) {
  const argv = ["claude", "plugin", "install", "crosstalk", "--marketplace", pc.marketplace];
  const env = { CLAUDE_CONFIG_DIR: pc.isWindows ? norm(folder).replace(/\//g, "\\") : norm(folder) };
  // Twice, in case the first go hits a passing network fault.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result = null;
    try {
      result = await $.process.run(argv, { env, timeoutMs: 120_000 });
    } catch {
      if (pc.isWindows) {
        result = await $.process.run(["cmd.exe", "/d", "/c", ...argv], { env, timeoutMs: 120_000 }).catch(() => null);
      }
    }
    if (result?.exitCode === 0 && isInstalled((await readText($, `${folder}/plugins/installed_plugins.json`)) ?? "")) {
      return true;
    }
  }
  return false;
}

// Add shortcuts to a shell file, keeping those already there, with a copy of the file as it was.
async function writeShortcuts($, target, rows) {
  const keep = shortcutsIn(target.text).filter((s) => !rows.some((r) => r.name === s.name || sameFolder(r.folder, s.folder)));
  const block = shortcutBlock(target.kind, [...keep, ...rows.map((r) => ({ name: r.name, folder: r.folder }))]);
  const next = mergeBlock(target.text, block);
  if (next === target.text) {
    return;
  }
  if (target.text !== "") {
    await $.fs.write(`${target.path}.crosstalk-backup`, target.text);
  }
  await $.fs.write(target.path, next);
}

async function saveSetup($, setup) {
  await $.fs.write(`${root}/setup.json`, JSON.stringify(setup, null, 2));
}

async function setupCommand($, words) {
  const pc = await computer($);
  const setup = await readJson($, `${root}/setup.json`, {});
  const verb = String(words[0] ?? "").toLowerCase();
  const preview = async (first = "") => {
    const s = await survey($, pc, setup);
    return `${first ? `${first}\n\n` : ""}${previewText(s.plan, s.targets, s.problems, pc.home)}`;
  };
  if (verb === "") {
    return preview();
  }
  if (verb === "yes") {
    return applySetup($, pc, setup);
  }
  // The rest correct the list, and need a profile that's on it.
  const { profiles } = await survey($, pc, setup);
  const named = (name) => profiles.find((p) => p.name === String(name ?? "").toLowerCase());
  if (verb === "add") {
    const folder = norm(words[1]).replace(/^~(?=\/|$)/, pc.home);
    if (!folder || !(await listFolder($, folder))) {
      return `Usage: /crosstalk setup add <folder> [name]. The folder has to exist${folder ? `, and ${folder} doesn't` : ""}. Put a path with spaces in double quotes.`;
    }
    setup.folders = [...(setup.folders ?? []).filter((f) => !sameFolder(f, folder)), folder];
    setup.skip = (setup.skip ?? []).filter((f) => !sameFolder(f, folder));
    const name = String(words[2] ?? "").toLowerCase();
    if (name && !isSafeName(name)) {
      return `"${name}" can't be a name: use letters, numbers, - and _.`;
    }
    if (name) {
      setup.names = { ...setup.names, [folder]: name };
    }
    await saveSetup($, setup);
    return preview(`Added ${tilde(folder, pc.home)}.`);
  }
  if (verb === "skip") {
    const p = named(words[1]);
    if (!p || sameFolder(p.folder, pc.current)) {
      return p ? "This session's own profile can't be left out." : `Usage: /crosstalk setup skip <name>. Names: ${profiles.map((x) => x.name).join(", ")}.`;
    }
    setup.skip = [...(setup.skip ?? []), p.folder];
    await saveSetup($, setup);
    return preview(`Leaving out ${p.name}. /crosstalk setup add ${tilde(p.folder, pc.home)} brings it back.`);
  }
  if (verb === "name") {
    const p = named(words[1]);
    const name = String(words[2] ?? "").toLowerCase();
    if (!p || !isSafeName(name)) {
      return `Usage: /crosstalk setup name <name> <new name>, with letters, numbers, - and _. Names: ${profiles.map((x) => x.name).join(", ")}.`;
    }
    if (profiles.some((x) => x.name === name && !sameFolder(x.folder, p.folder))) {
      return `Another profile is already called ${name}.`;
    }
    setup.names = { ...setup.names, [p.folder]: name };
    await saveSetup($, setup);
    return preview(`${p.name} is now ${name}, from the next time a session starts on it.`);
  }
  return `Unknown: ${verb}. Try /crosstalk setup.`;
}

async function applySetup($, pc, setup) {
  const { plan, targets, problems } = await survey($, pc, setup);
  if (!plan.toInstall.length && !plan.shortcuts.length) {
    return "Nothing to do: every profile here has Crosstalk and a way to start it.";
  }
  const lines = [];
  for (const r of plan.toInstall) {
    if (await installOn($, pc, r.folder)) {
      lines.push(`Installed on ${r.name}.`);
    } else {
      lines.push(`Couldn't install on ${r.name}. Run this in a terminal:`, `  ${manualInstall(r.folder, pc.marketplace, pc.isWindows)}`);
    }
  }
  for (const target of targets) {
    if (plan.shortcuts.length) {
      await writeShortcuts($, target, plan.shortcuts);
      lines.push(`Added ${plan.shortcuts.map((r) => `claude-${r.name}`).join(", ")} to ${tilde(target.path, pc.home)}.`);
    }
  }
  lines.push(...problems, "", "Next:");
  if (plan.shortcuts.length) {
    lines.push(`  - Open a new terminal so it picks up the shortcuts, then start each profile: ${plan.shortcuts.map((r) => `claude-${r.name}`).join(", ")}`);
    lines.push("  - A profile asks you to log in the first time.");
  }
  lines.push("  - Restart any session already open, as sessions load Crosstalk when they start.", "  - Then run /crosstalk on any of them to see who it can reach.");
  return lines.join("\n");
}

// A new profile, ready to log in to.
async function addProfile($, name) {
  if (!isSafeName(name)) {
    return "Usage: /crosstalk add <name>, with letters, numbers, - and _, such as /crosstalk add work.";
  }
  const pc = await computer($);
  const folder = `${pc.home}/.claude-${name}`;
  if (!isSafeFolder(folder)) {
    return `Your home folder has a character a shortcut can't hold. Make ${folder} by hand, then run /crosstalk setup.`;
  }
  if (((await listFolder($, folder)) ?? []).length) {
    return `${tilde(folder, pc.home)} is already there. /crosstalk setup shows what it would do with it.`;
  }
  const setup = await readJson($, `${root}/setup.json`, {});
  if ((await survey($, pc, setup)).profiles.some((p) => p.name === name)) {
    return `Another profile is already called ${name}. Pick another name.`;
  }
  const lines = [];
  if (await installOn($, pc, folder)) {
    lines.push(`Made ${tilde(folder, pc.home)} and installed Crosstalk on it.`);
  } else {
    lines.push(`Couldn't install on it. Run this in a terminal:`, `  ${manualInstall(folder, pc.marketplace, pc.isWindows)}`);
  }
  const { targets, problems } = await readShells($, pc);
  for (const target of targets) {
    await writeShortcuts($, target, [{ name, folder }]);
    lines.push(`Added claude-${name} to ${tilde(target.path, pc.home)}.`);
  }
  lines.push(...problems);
  lines.push(targets.length
    ? `Open a new terminal and run claude-${name}. It asks you to log in the first time, with its own account.`
    : `No shell file to add a shortcut to, so start it with: ${pc.isWindows ? `$env:CLAUDE_CONFIG_DIR = "${folder.replace(/\//g, "\\")}"; claude` : `CLAUDE_CONFIG_DIR="${folder}" claude`}`);
  return lines.join("\n");
}

function failed(text) {
  return { deny: text }; // the model reads it as the tool's error
}

function notReady() {
  return failed("Crosstalk did not start in this session.");
}

async function startUp($) {
  const home = (await $.env.get("CLAUDE_CROSSTALK_HOME")) || (await $.env.get("USERPROFILE")) || (await $.env.get("HOME"));
  const folder = await $.env.get("CLAUDE_CROSSTALK_DIR");
  if (!folder && !home) {
    throw new Error("no home folder");
  }
  root = (folder || `${home}/.claude-crosstalk`).replace(/\\/g, "/").replace(/\/+$/, "");
  const wanted = Number(await $.env.get("CLAUDE_CROSSTALK_WAKE_LIMIT"));
  limit = wanted > 0 ? wanted : 25;
  const config = await $.env.get("CLAUDE_CONFIG_DIR");
  const given = (await $.env.get("CLAUDE_CROSSTALK_NAME")) || savedName(await readJson($, `${root}/setup.json`, {}), config || `${home}/.claude`);
  const profile = profileName(given, config, $.plugin.root);
  const id = await $.session.id();
  const cwd = await $.session.cwd();
  me = { id, profile, address: addressOf(profile, cwd, id), cwd, startedAt: await $.clock.now() };
  delivered = new Set(await readJson($, `${root}/inbox/${id}/_delivered.json`, []));
  await beat($);
  await $.tool.register({
    name: "send",
    description: "Send a message to another Claude Code session on this computer, including one on another profile or AI provider. `to` is an address from the crosstalk list tool, or a profile name if that profile has one session running.",
    inputSchema: { type: "object", properties: { to: { type: "string", description: "Who it is for" }, text: { type: "string", description: "The message" } }, required: ["to", "text"] },
    isDeferred: false,
  });
  await $.tool.register({
    name: "list",
    description: "List the other Claude Code sessions on this computer that Crosstalk can reach, on any profile, and this session's own address.",
    inputSchema: { type: "object", properties: {} },
    isDeferred: false,
  });
  await $.command.register({ name: "crosstalk", description: "Shows who Crosstalk can reach. /crosstalk setup connects your other profiles; /crosstalk add <name> makes a new one; off and on pause it." });
  $.clock.every(BEAT_MS, () => beat($).catch(() => {}));
  $.clock.every(POLL_MS, () => poll($).catch(() => {}));
  void prune($);
}

// Say this session is still running.
async function beat($, extra = {}) {
  await $.fs.write(`${root}/sessions/${me.id}.json`, JSON.stringify({ ...me, seenAt: await $.clock.now(), ...extra }));
}

async function readJson($, path, fallback) {
  try {
    return JSON.parse(await $.fs.read(path));
  } catch {
    return fallback;
  }
}

async function readSessions($) {
  const entries = await $.fs.list(`${root}/sessions`).catch(() => []);
  const records = await Promise.all(entries.filter((f) => f.name.endsWith(".json")).map((f) => readJson($, `${root}/sessions/${f.name}`, null)));
  return records.filter((r) => r && typeof r.seenAt === "number" && typeof r.address === "string" && typeof r.profile === "string");
}

// The messages to deliver. A file that does not parse may still be being written, so it is read
// again next time, until it is plainly never going to.
async function readInbox($) {
  const entries = await $.fs.list(`${root}/inbox/${me.id}`).catch(() => []);
  const batch = [];
  for (const name of pendingNames(entries, delivered)) {
    const message = await readJson($, `${root}/inbox/${me.id}/${name}`, null);
    if (message && typeof message.text === "string") {
      batch.push({ ...message, name });
      continue;
    }
    const count = (tries.get(name) ?? 0) + 1;
    tries.set(name, count);
    if (count >= BAD_TRIES) {
      delivered.add(name);
    }
  }
  return batch;
}

async function saveDelivered($) {
  await $.fs.write(`${root}/inbox/${me.id}/_delivered.json`, JSON.stringify([...delivered]));
}

async function markDelivered($, batch) {
  for (const message of batch) {
    delivered.add(message.name);
  }
  await saveDelivered($);
}

async function unmark($, batch) {
  for (const message of batch) {
    delivered.delete(message.name);
  }
  await saveDelivered($);
}

// Called only once a batch is on its way to the model: the person sees the toast and, in the
// transcript, the messages themselves, so nothing depends on the model passing them on.
function noteArrival($, batch) {
  const from = [...new Set(batch.map((m) => m.from))].join(", ");
  $.ui.toast(`Crosstalk: ${batch.length === 1 ? "a message" : `${batch.length} messages`} from ${from}`);
  $.ui.log(showMessages(batch, `${root}/inbox/${me.id}`));
}

// Between turns: a message starts a turn, up to the limit.
async function poll($) {
  if (!me || isOff || isBusy || isPolling) {
    return;
  }
  isPolling = true;
  try {
    const batch = await readInbox($);
    if (batch.length === 0) {
      return;
    }
    if (!mayWake(wakes, limit)) {
      if (!warned) {
        warned = true;
        $.ui.toast(`Crosstalk: ${batch.length} waiting. ${limit} wake-ups in a row, so they wait until you type.`);
      }
      return;
    }
    wakes += 1;
    isBusy = true; // until turn.complete; a person's typing in the meantime queues as usual
    noteArrival($, batch);
    await markDelivered($, batch);
    void $.prompt.submit({ text: frameMessages(batch) }).catch(() => {
      isBusy = false;
      return unmark($, batch);
    });
  } finally {
    isPolling = false;
  }
}

// Old records go, by a host command because $.fs has no delete. Failing is harmless.
async function prune($) {
  const script = `const fs=require('fs'),p=require('path');const r=process.argv[1];const cut=Date.now()-${PRUNE_DAYS}*864e5;for(const d of ['sessions','inbox'])for(const n of (fs.existsSync(p.join(r,d))?fs.readdirSync(p.join(r,d)):[])){const f=p.join(r,d,n);if(fs.statSync(f).mtimeMs<cut)fs.rmSync(f,{recursive:true,force:true})}`;
  await $.process.run(["node", "-e", script, root], { timeoutMs: 10_000 }).catch(() => {});
}
