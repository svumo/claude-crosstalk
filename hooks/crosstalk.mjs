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
  appPanelCommand, chooseOpenIn, DESKTOP_ENTRYPOINT, findOpened, HELPER_ID, isSafeLaunch, launchFor, NOT_IN_APP, OPEN_IN, PERMISSION_MODES, trustProject,
  vscodeLink, editorFor, EDITOR_CHOICES, helperInstall, windowArgv, withLaunchFlags, parseOpenArgs, macArgv, linuxArgv, linuxCandidates, whichArgv,
  LINUX_TERMINALS, appDataFolders, appTitle, HOST_SESSION, labelOf, listLine, projectFolderName, transcriptTitle,
  choiceLabel, chosenProfile, COMPACT_INSTRUCTIONS, flagApplies, flagEnds, handoffName, handoffText, isOver, isPaused, LARGE_CONTEXT, LARGE_STOP,
  moveChoices, NOT_NOW, parsePercent, pausedNote, resumePrompt, stopLine, stopPoint, stopReason, summaryOf, USAGE_STOP, usagePhrase, windowKey, windowName, worstWindow,
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
const OPEN = "mcp__crosstalk__open";
// The desktop app's own tool that types a command into a new tab of its Terminal panel.
const APP_TERMINAL = "mcp__terminal__run_in_terminal";
// How long a session being opened has to show up, looked for once a second.
const OPEN_WAIT_S = 90;
const PROFILE_WORD = /^[a-z0-9][a-z0-9_-]{0,30}$/;
// Marking a folder trusted: how many goes, and how long to wait before reading it back.
const TRUST_TRIES = 3;
const TRUST_CHECK_MS = 300;
const MARKETPLACE = "svumo/claude-crosstalk";
// Looking for the desktop app's file on this session: how many beats before giving up.
const APP_FILE_TRIES = 8;
// A transcript is read whole up to this size, else its last part. Title rows stay near the end.
const WHOLE_READ = 2 * 1024 * 1024;
const TAIL_BYTES = 128 * 1024;
// Once a title is known, a changing transcript is read again at most this often.
const TRANSCRIPT_EVERY_MS = 60_000;
// Usage guard: how long a stopped turn has to end, and how long a typed move waits for the command
// to finish before compacting (a compaction can't start while anything runs).
const ABORT_WAIT_MS = 15_000;
const MOVE_DELAY_MS = 1_000;

let limit = 25;
// { id, profile, address, cwd, startedAt, title }, set at session.start; title is kept current.
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
// Where this session's title comes from, found at start and read again on each beat.
let titling = null;
// The running main turn, so the usage guard can stop it, and a promise that settles when it ends.
let mainTurn = null;
let turnEnded = Promise.resolve();
let endTurn = () => {};
// Usage guard state. window: the fullest rate-limit window last measured; account/large/launch:
// the settings; here: this session's own stop point; handled: windows already acted on; isHeld:
// no wake-ups until heldUntil (the window's reset). here, handled and heldUntil are kept in the
// session's record, so a reload of the mod doesn't stop it twice.
let usage = freshUsage();

function freshUsage() {
  return { window: null, contextPercent: undefined, account: USAGE_STOP, large: { stop: LARGE_STOP, context: LARGE_CONTEXT }, launch: [], here: 0, handled: new Set(), isHeld: false, heldUntil: 0, isStopping: false };
}

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
      mainTurn = e.turnId ?? null;
      turnEnded = new Promise((resolve) => { endTurn = resolve; });
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      isBusy = false;
      openTools = 0;
      mainTurn = null;
      endTurn();
      void poll($);
    }
    return result;
  });

  // The usage guard reads every measurement: a window over this session's stop point stops it.
  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    if (me) {
      usage.window = worstWindow(e.rateLimits) ?? usage.window;
      usage.contextPercent = e.context?.percent ?? usage.contextPercent;
      void checkUsage($).catch(() => {});
    }
    return result;
  });

  // Mid-turn delivery: after a response's last tool result the loop always asks the model again.
  // The new row is started but not awaited: this row's own append has to finish first.
  on("session.append", async ($, e, next) => {
    const stored = await next(e);
    if (e.agentId !== undefined || !me || isOff || usage.isHeld || usage.isStopping) {
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
    const lines = others.map((r) => `${listLine(r)}${isPaused(r) ? " (paused near its usage limit)" : ""}`);
    const mine = usagePhrase(me.usage);
    return { result: `You are ${labelOf(me)}${mine ? `, ${mine}` : ""}.\n${lines.length ? `Also running:\n${lines.join("\n")}` : "No other session is running Crosstalk."}` };
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
    await writeMessage($, found.record, text, now);
    if (isPaused(found.record)) {
      return { result: `Sent to ${labelOf(found.record)}.${pausedNote(found.record)}` };
    }
    return { result: `Sent to ${labelOf(found.record)}. It arrives within a few seconds, or after the step that session is on.` };
  });

  on("tool.call", { tool: OPEN }, async ($, e) => {
    if (!me) {
      return notReady();
    }
    const opened = await openSession($, String(e.profile ?? "").trim().toLowerCase(), String(e.message ?? ""), { model: e.model, permissionMode: e.permissionMode });
    return opened.error ? failed(opened.error) : { result: opened.text };
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
    if (word === "open") {
      const parts = parseOpenArgs(words.slice(1));
      if (parts.error) {
        return { text: parts.error };
      }
      const opened = await openSession($, parts.profile, parts.message, { model: parts.model, permissionMode: parts.permissionMode });
      return { text: opened.error ?? opened.text };
    }
    if (word === "open-in") {
      return { text: await openInCommand($, String(words[1] ?? "").toLowerCase()) };
    }
    if (word === "editor") {
      return { text: await editorCommand($, String(words[1] ?? "").toLowerCase()) };
    }
    if (word === "usage") {
      return { text: await usageCommand($, words.slice(1)) };
    }
    if (word === "move") {
      return { text: await moveCommand($, String(words[1] ?? "").toLowerCase()) };
    }
    if (word === "launch") {
      return { text: await launchCommand($, String(words[1] ?? "").toLowerCase(), words.slice(2).join(" ")) };
    }
    const now = await $.clock.now();
    const others = (await readSessions($)).filter((r) => r.id !== me.id && isLive(r, now)).map(labelOf);
    const hint = others.length ? "" : " /crosstalk setup connects your other profiles.";
    return { text: `You are ${labelOf(me)}${isOff ? " (off)" : ""}. Others running: ${others.join(", ") || "none"}. Wake-ups since you last typed: ${wakes} of ${limit}.${hint}` };
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

async function writeMessage($, record, text, now) {
  const name = messageFileName(now, Math.random().toString(36).slice(2, 10));
  await $.fs.write(`${root}/inbox/${record.id}/${name}`, JSON.stringify({ from: me.address, fromTitle: me.title || undefined, fromId: me.id, to: record.address, sentAt: now, text }));
}

// The VS Code (or VSCodium) command line. On Windows `code` and `codium` are .cmd files that
// only cmd.exe starts.
async function runCode($, pc, editor, args) {
  try {
    return await $.process.run([editor.cli, ...args], { timeoutMs: 30_000 });
  } catch {
    return pc.isWindows ? $.process.run(["cmd.exe", "/d", "/c", editor.cli, ...args], { timeoutMs: 30_000 }).catch(() => null) : null;
  }
}

async function hasHelper($, pc, editor) {
  const listed = await runCode($, pc, editor, ["--list-extensions"]);
  return Boolean(listed && listed.exitCode === 0 && listed.stdout.toLowerCase().split(/\r?\n/).map((l) => l.trim()).includes(HELPER_ID));
}

// Where `open` would put a new session from this one, and why: the editor (spotted from this
// session's terminal, or set), whether its helper is installed, and the choice that follows.
async function resolveOpening($, pc, setup) {
  const fromEnv = await $.env.get("CLAUDE_CROSSTALK_OPEN_IN");
  const termProgram = await $.env.get("TERM_PROGRAM");
  const editor = editorFor(await $.env.get("CLAUDE_CROSSTALK_EDITOR"), setup.editor, await $.env.get("VSCODE_GIT_ASKPASS_NODE"));
  const wanted = String(fromEnv || setup.openIn || "auto").toLowerCase();
  const inApp = (await $.env.get("CLAUDE_CODE_ENTRYPOINT")) === DESKTOP_ENTRYPOINT;
  // The editor helper only matters when open may use an editor tab.
  const checked = wanted === "vscode" || (wanted !== "window" && wanted !== "app" && !inApp);
  const helper = checked ? await hasHelper($, pc, editor) : false;
  const choice = chooseOpenIn(fromEnv, setup.openIn, termProgram, helper, editor.label, inApp);
  const inEditor = String(termProgram ?? "").toLowerCase() === "vscode";
  return { fromEnv, editor, helper, checked, choice, inEditor, inApp };
}

// One line that says what `open` will do from here, and how to change it.
function describeOpening(r, pluginRoot) {
  if (r.choice.where === "app") {
    return "From this session, open starts a new tab in the Claude desktop app's Terminal panel, as this session runs in the app. The app asks you to approve the command first.";
  }
  const where = r.choice.where === "vscode" ? `a ${r.editor.label} terminal tab` : "a new terminal window";
  const how = { CLAUDE_CROSSTALK_EDITOR: "set by CLAUDE_CROSSTALK_EDITOR", saved: "set by /crosstalk editor", spotted: r.inEditor ? "spotted from this session's terminal" : "the default, as this session isn't in an editor terminal" }[r.editor.how];
  const lines = [`From this session, open starts ${where}.`, `Editor: ${r.editor.label} (${how}). Helper: ${!r.checked ? `not checked, as open-in is ${r.choice.why === NOT_IN_APP ? "app" : "window"}` : r.helper ? "installed" : "not found"}.`];
  if (r.choice.why) {
    lines.push(`Why a window: ${r.choice.why}.`);
  }
  if (r.checked && !r.helper && (r.inEditor || r.choice.why)) {
    lines.push(`Install the helper: ${helperInstall(r.editor, pluginRoot)}, then reload the ${r.editor.label} window.`);
  }
  return lines.join("\n");
}

async function openInCommand($, value) {
  const setup = await readJson($, `${root}/setup.json`, {});
  if (value === "") {
    const fromEnv = await $.env.get("CLAUDE_CROSSTALK_OPEN_IN");
    const now = describeOpening(await resolveOpening($, await computer($), setup), $.plugin.root);
    return `New sessions open in: ${setup.openIn ?? "auto"}${fromEnv ? ` (CLAUDE_CROSSTALK_OPEN_IN=${fromEnv} wins)` : ""}. Choices: ${OPEN_IN.join(", ")}.\n${now}`;
  }
  if (!OPEN_IN.includes(value)) {
    return `Usage: /crosstalk open-in ${OPEN_IN.join("|")}. auto is a tab in the Claude desktop app's Terminal panel when this session runs in the app, an editor tab (VS Code or VSCodium) when it runs in one, else a new terminal window.`;
  }
  setup.openIn = value;
  await saveSetup($, setup);
  return `New sessions open in: ${value}.`;
}

// Which editor the tab opens in: auto spots VS Code or VSCodium from this session's terminal.
async function editorCommand($, value) {
  const setup = await readJson($, `${root}/setup.json`, {});
  const fromEnv = await $.env.get("CLAUDE_CROSSTALK_EDITOR");
  const wins = fromEnv ? ` (CLAUDE_CROSSTALK_EDITOR=${fromEnv} wins)` : "";
  if (value === "") {
    return `Editor: ${setup.editor ?? "auto"}${wins}. Choices: ${EDITOR_CHOICES.join(", ")}. auto spots VS Code or VSCodium from the terminal this session runs in.`;
  }
  const word = { vscode: "code", vscodium: "codium" }[value] ?? value;
  if (!EDITOR_CHOICES.includes(word)) {
    return `Usage: /crosstalk editor ${EDITOR_CHOICES.join("|")}. auto spots VS Code or VSCodium from the terminal this session runs in.`;
  }
  if (word === "auto") {
    delete setup.editor;
  } else {
    setup.editor = word;
  }
  await saveSetup($, setup);
  return `Editor: ${word}${wins}.`;
}

async function launchCommand($, profile, command) {
  const setup = await readJson($, `${root}/setup.json`, {});
  if (!PROFILE_WORD.test(profile)) {
    const saved = Object.entries(setup.launch ?? {}).map(([p, c]) => `${p}: ${c}`).join(", ");
    return `Usage: /crosstalk launch <profile> <command>, such as /crosstalk launch zai claude zai.${saved ? ` Saved: ${saved}.` : ""}`;
  }
  if (command.trim() === "") {
    return `${profile} starts with: ${launchFor(profile, setup)}`;
  }
  if (!isSafeLaunch(command.trim())) {
    return `Crosstalk only starts Claude Code: a command that is claude or claude-<name>, then plain words, such as "claude zai".`;
  }
  setup.launch = { ...setup.launch, [profile]: command.trim() };
  await saveSetup($, setup);
  return `${profile} starts with: ${command.trim()}`;
}

// Mark this folder trusted in the profile about to start here, so it doesn't wait at "Is this a
// project you trust?" with nobody there to answer. This session already runs in the folder, so
// the person trusted it; the trust is only carried over to the session they asked to open.
// Returns true when the profile's record says trusted afterwards.
async function trustFolder($, pc, setup, profile) {
  const found = (await survey($, pc, setup)).profiles.find((p) => p.name === profile);
  if (!found) {
    return false;
  }
  // Under CLAUDE_CONFIG_DIR the record is in that folder; plain ~/.claude keeps it at ~/.claude.json.
  const paths = [`${found.folder}/.claude.json`];
  if (sameFolder(found.folder, `${pc.home}/.claude`)) {
    paths.push(`${pc.home}/.claude.json`);
  }
  let isTrusted = false;
  for (const path of paths) {
    isTrusted = (await trustFile($, path)) || isTrusted;
  }
  return isTrusted;
}

// A session already running on that profile rewrites the file now and then, and may write over
// the change with its own copy. So the file is read back after a moment, and marked again if the
// mark is gone. Returns true when the file says trusted.
async function trustFile($, path) {
  for (let attempt = 0; attempt < TRUST_TRIES; attempt += 1) {
    const text = await readText($, path);
    if (text === null) {
      return false;
    }
    const next = trustProject(text, me.cwd);
    if (next === null) {
      return parsesAsObject(text); // already trusted, or not safe to touch
    }
    try {
      await $.fs.write(path, next);
    } catch {
      return false; // the launch still goes ahead
    }
    await $.clock.sleep(TRUST_CHECK_MS);
  }
  const last = await readText($, path);
  return last !== null && trustProject(last, me.cwd) === null && parsesAsObject(last);
}

function parsesAsObject(text) {
  try {
    const data = JSON.parse(text);
    return Boolean(data) && typeof data === "object" && !Array.isArray(data);
  } catch {
    return false;
  }
}

// Start a session on `profile` in a new terminal, here in this folder, then say so when it is up
// and hand it `message`. `opts` may set its model and permission mode. Returns { text } at once,
// or { error }.
async function openSession($, profile, message, opts = {}) {
  if (!PROFILE_WORD.test(profile)) {
    return { error: "Usage: /crosstalk open <profile> [--model <model>] [--mode <permission mode>] [first message], such as /crosstalk open zai --mode plan say hello." };
  }
  const setup = await readJson($, `${root}/setup.json`, {});
  const flagged = withLaunchFlags(launchFor(profile, setup), opts);
  if (flagged.error) {
    return { error: flagged.error };
  }
  const command = flagged.command;
  if (!isSafeLaunch(command)) {
    return { error: `${profile} would start with "${command}", and Crosstalk only starts Claude Code. Set it with /crosstalk launch ${profile} <command>.` };
  }
  const pc = await computer($);
  const isTrusted = await trustFolder($, pc, setup, profile).catch(() => false);
  const { editor, choice } = await resolveOpening($, pc, setup);
  const since = await $.clock.now();
  let ran = null;
  let place = "a new terminal window";
  if (choice.where === "app") {
    const opened = await openInApp($, profile, appPanelCommand(command, pc.isWindows));
    if (opened.error) {
      return { error: opened.error };
    }
    place = "a new tab of the app's Terminal panel";
    ran = { exitCode: 0 };
  } else if (choice.where === "vscode") {
    place = `a new ${editor.label} terminal`;
    ran = await runCode($, pc, editor, ["--open-url", vscodeLink({ name: `claude ${profile}`, cwd: me.cwd, cmd: command }, editor.scheme)]);
  } else {
    const opener = pc.isWindows ? { argv: windowArgv(me.cwd, command) } : await unixWindow($, command);
    if (opener.error) {
      return { error: opener.error };
    }
    place = opener.place ?? place;
    ran = await $.process.run(opener.argv, { timeoutMs: opener.timeoutMs ?? 30_000 }).catch(() => null);
    if (opener.isMac && ran && ran.exitCode !== 0 && /-1743|not authori[sz]ed/i.test(ran.stderr ?? "")) {
      return { error: "macOS didn't let Crosstalk control Terminal. Allow it in System Settings > Privacy & Security > Automation, under the app this session runs in, then try again." };
    }
  }
  if (!ran || ran.exitCode !== 0) {
    return { error: `Couldn't open ${place}${ran?.stderr ? `: ${ran.stderr.trim().slice(0, 200)}` : "."}` };
  }
  void watchOpened($, profile, since - 2_000, message).catch(() => {});
  const trust = isTrusted ? "" : ` Crosstalk couldn't mark this folder trusted for ${profile}, so it may stop at the folder-trust screen until someone answers it.`;
  return { text: `Opening ${profile} (${command}) in ${place}${choice.why ? `, as ${choice.why}` : ""}. Crosstalk says here when it is up${message.trim() ? ", then sends it your message" : ""}.${trust}` };
}

// A new tab in the Claude desktop app's Terminal panel, through the app's own tool, so the
// session runs inside the app on that profile's account. The app shows the person the command to
// approve. Its shell runs their profile, so `claude mikey`-style functions work there. Returns {}
// or { error }.
async function openInApp($, profile, command) {
  const instead = "/crosstalk open-in window opens a terminal window instead.";
  let answer;
  try {
    answer = await $.tool.call({ tool: APP_TERMINAL, command, cwd: me.cwd, title: `claude ${profile}` });
  } catch (err) {
    return { error: `Couldn't reach the app's Terminal panel (${String(err?.message ?? err).slice(0, 200)}). ${instead}` };
  }
  if (answer?.deny) {
    return { error: `The app's Terminal panel didn't run it: ${String(answer.deny).slice(0, 300)}. ${instead}` };
  }
  if (answer?.isError) {
    return { error: `The app's Terminal panel didn't run it: ${resultText(answer).slice(0, 300)}. ${instead}` };
  }
  return {};
}

function resultText(answer) {
  const result = answer?.text ?? answer?.result;
  if (typeof result === "string") {
    return result;
  }
  if (Array.isArray(result)) {
    return result.map((part) => part?.text ?? "").join(" ").trim();
  }
  return JSON.stringify(result ?? "");
}

// A new terminal on macOS (Terminal.app) or Linux (the first terminal found). Returns
// { argv, place } or { error }.
async function unixWindow($, command) {
  const system = await $.process.run(["uname", "-s"], { timeoutMs: 10_000 }).catch(() => null);
  if (String(system?.stdout ?? "").trim() === "Darwin") {
    // The first time, macOS asks the person whether this may control Terminal, and osascript
    // waits for the answer, so it gets two minutes.
    return { argv: macArgv(me.cwd, command), place: "a new Terminal window", isMac: true, timeoutMs: 120_000 };
  }
  const candidates = linuxCandidates({
    wanted: await $.env.get("CLAUDE_CROSSTALK_TERMINAL"),
    inTmux: Boolean(await $.env.get("TMUX")),
    hasDisplay: Boolean((await $.env.get("DISPLAY")) || (await $.env.get("WAYLAND_DISPLAY"))),
  });
  const found = candidates.length
    ? await $.process.run(whichArgv(candidates), { timeoutMs: 10_000 }).catch(() => null)
    : null;
  const terminal = String(found?.stdout ?? "").trim();
  if (!LINUX_TERMINALS.includes(terminal)) {
    return { error: `Couldn't find a terminal to open: Crosstalk looks for ${LINUX_TERMINALS.join(", ")}${candidates.includes("tmux") ? "" : " (tmux only from inside tmux)"}, and the desktop ones need a display. Set CLAUDE_CROSSTALK_TERMINAL to choose one, or use VS Code with the Crosstalk terminal helper.` };
  }
  const shell = await $.env.get("SHELL");
  return { argv: linuxArgv(terminal, me.cwd, command, shell), place: terminal === "tmux" ? "a new tmux window" : `a new ${terminal} window` };
}

async function watchOpened($, profile, since, message) {
  for (let i = 0; i < OPEN_WAIT_S; i += 1) {
    await $.clock.sleep(1_000);
    const now = await $.clock.now();
    const found = findOpened(await readSessions($), profile, me.cwd, since, now);
    if (found) {
      if (message.trim()) {
        await writeMessage($, found, message.trim(), now);
      }
      $.ui.log(`Crosstalk: ${labelOf(found)} is up${message.trim() ? " and has your message" : ""}.`);
      return;
    }
  }
  $.ui.log(`Crosstalk: no ${profile} session showed up within ${OPEN_WAIT_S} seconds. Check the new terminal, and /crosstalk launch ${profile} for the command it ran.`);
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
  const alias = addressOf(profile, cwd, id);
  me = { id, profile, address: alias, alias, cwd, startedAt: await $.clock.now(), title: "" };
  titling = await titleSources($, profile, config || `${home}/.claude`, id, cwd);
  me.account = titling.account || undefined;
  usage = freshUsage();
  const kept = (await readJson($, `${root}/sessions/${id}.json`, null))?.guard;
  if (kept) {
    usage.here = Number(kept.here) || 0;
    usage.handled = new Set(Array.isArray(kept.handled) ? kept.handled : []);
    usage.heldUntil = Number(kept.heldUntil) || 0;
    usage.isHeld = usage.heldUntil > (await $.clock.now());
  }
  await loadGuard($);
  delivered = new Set(await readJson($, `${root}/inbox/${id}/_delivered.json`, []));
  await beat($);
  await $.tool.register({
    name: "send",
    description: "Send a message to another Claude Code session on this computer, including one on another profile or AI provider. `to` is an address from the crosstalk list tool, a session's title as list shows it when only one session has it, or a profile name if that profile has one session running.",
    inputSchema: { type: "object", properties: { to: { type: "string", description: "Who it is for" }, text: { type: "string", description: "The message" } }, required: ["to", "text"] },
    isDeferred: false,
  });
  await $.tool.register({
    name: "list",
    description: "List the other Claude Code sessions on this computer that Crosstalk can reach, on any profile, each by its title (as the desktop app or /rename names it) and address, and this session's own.",
    inputSchema: { type: "object", properties: {} },
    isDeferred: false,
  });
  await $.tool.register({
    name: "open",
    description: "Start a new Claude Code session on a profile (such as zai or work) in a new terminal, in this session's folder, and optionally send it a first message once it is up. Opens in a tab of the Claude desktop app's Terminal panel when this session runs in the app (so the profile's own account runs inside the app), in VS Code or VSCodium when this session runs there, else in a new terminal window. `model` and `permissionMode` set the new session's model and permission mode; left out, it uses the profile's own launch settings. The folder is marked trusted for that profile first, so it starts without the trust screen.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "The profile to start, as /crosstalk names them" },
        message: { type: "string", description: "A first message to send it once it is running" },
        model: { type: "string", description: "Model for the new session, one word such as sonnet, opus or claude-sonnet-5-5" },
        permissionMode: { type: "string", enum: PERMISSION_MODES, description: "Permission mode for the new session" },
      },
      required: ["profile"],
    },
    isDeferred: false,
  });
  await $.command.register({ name: "crosstalk", description: "Shows who Crosstalk can reach. open <profile> [--model m] [--mode p] [message] starts one; open-in, editor and launch set how (open-in alone shows what it will do); setup connects profiles; add <name> makes one; usage shows or sets where sessions stop near the usage limit; move <profile> hands this session to another account now; off and on pause it." });
  $.clock.every(BEAT_MS, () => beat($).catch(() => {}));
  $.clock.every(POLL_MS, () => poll($).catch(() => {}));
  void prune($);
}

// Say this session is still running, under its title as it is now.
async function beat($, extra = {}) {
  if (!extra.endedAt) {
    me.title = (await currentTitle($).catch(() => "")) || me.title;
    // The address follows the title, so it reads as the name the person sees.
    me.address = addressOf(me.profile, me.cwd, me.id, me.title);
    await loadGuard($).catch(() => {});
  }
  me.usage = usageRecord();
  me.guard = { here: usage.here, handled: [...usage.handled], heldUntil: usage.heldUntil };
  await $.fs.write(`${root}/sessions/${me.id}.json`, JSON.stringify({ ...me, seenAt: await $.clock.now(), ...extra }));
}

// Where to read this session's title. A desktop-app session (CLAUDE_CODE_HOST_SESSION_ID) has a
// file in the app's data folder, which is looked for in each place an app may keep it. Every
// session has its transcript, under the profile's projects folder.
async function titleSources($, profile, configDir, id, cwd) {
  const hostId = String((await $.env.get("CLAUDE_CODE_HOST_SESSION_ID")) ?? "");
  const folders = HOST_SESSION.test(hostId)
    ? appDataFolders({
      override: await $.env.get("CLAUDE_CROSSTALK_APP_DATA"),
      execPath: await $.env.get("CLAUDE_CODE_EXECPATH"),
      appData: await $.env.get("APPDATA"),
      localAppData: await $.env.get("LOCALAPPDATA"),
      home: (await $.env.get("USERPROFILE")) || (await $.env.get("HOME")),
      profile,
    })
    : [];
  return {
    hostId: folders.length ? hostId : "", folders, appFile: null, appTries: 0,
    account: String((await $.env.get("CLAUDE_CODE_ACCOUNT_UUID")) ?? ""),
    org: String((await $.env.get("CLAUDE_CODE_ORGANIZATION_UUID")) ?? ""),
    transcript: `${String(configDir).replace(/\\/g, "/").replace(/\/+$/, "")}/projects/${projectFolderName(cwd)}/${id}.jsonl`,
    seenMtime: 0, readAt: 0, transcriptTitle: "",
  };
}

// The title the person sees now: the desktop app's, else the transcript's. "" for none yet.
async function currentTitle($) {
  if (!titling) {
    return "";
  }
  if (titling.hostId && !titling.appFile && titling.appTries < APP_FILE_TRIES) {
    titling.appTries += 1;
    titling.appFile = await findAppFile($, titling);
  }
  if (titling.appFile) {
    const text = await readText($, titling.appFile);
    const title = text === null ? "" : appTitle(text, me.id);
    if (title) {
      return title;
    }
  }
  return transcriptTitleNow($);
}

// <user data>/claude-code-sessions/<account>/<org>/<local_id>.json, in the first folder that has it.
async function findAppFile($, t) {
  const name = `${t.hostId}.json`;
  const isThere = (path) => $.fs.exists(path).catch(() => false);
  for (const folder of t.folders) {
    const base = `${folder}/claude-code-sessions`;
    if (t.account && t.org && (await isThere(`${base}/${t.account}/${t.org}/${name}`))) {
      return `${base}/${t.account}/${t.org}/${name}`;
    }
    for (const account of ((await listFolder($, base)) ?? []).filter((e) => e.kind === "dir")) {
      for (const org of ((await listFolder($, `${base}/${account.name}`)) ?? []).filter((e) => e.kind === "dir")) {
        if (await isThere(`${base}/${account.name}/${org.name}/${name}`)) {
          return `${base}/${account.name}/${org.name}/${name}`;
        }
      }
    }
  }
  return null;
}

// The transcript's title, read again only when the file has changed, and once a title is known
// at most once a minute.
async function transcriptTitleNow($) {
  const t = titling;
  const stat = await $.fs.stat(t.transcript).catch(() => null);
  if (!stat || stat.kind !== "file") {
    return t.transcriptTitle;
  }
  const now = await $.clock.now();
  if (stat.mtimeMs === t.seenMtime || (t.transcriptTitle && now - t.readAt < TRANSCRIPT_EVERY_MS)) {
    return t.transcriptTitle;
  }
  const text = stat.size <= WHOLE_READ ? await readText($, t.transcript) : await readTail($, t.transcript);
  if (text !== null) {
    t.seenMtime = stat.mtimeMs;
    t.readAt = now;
    t.transcriptTitle = transcriptTitle(text) || t.transcriptTitle;
  }
  return t.transcriptTitle;
}

// The last part of a file too big to read whole, by a host command, as $.fs reads whole files.
async function readTail($, path) {
  const script = `const fs=require('fs');const f=fs.openSync(process.argv[1],'r');const n=fs.fstatSync(f).size;const k=Math.min(n,${TAIL_BYTES});const b=Buffer.alloc(k);fs.readSync(f,b,0,k,n-k);process.stdout.write(b.toString('utf8'))`;
  const ran = await $.process.run(["node", "-e", script, path], { timeoutMs: 10_000 }).catch(() => null);
  return ran && ran.exitCode === 0 ? ran.stdout : null;
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
  if (!me) {
    return;
  }
  // The usage guard looks first, as a session mid-turn has to be reached too.
  await checkFlags($).catch(() => {});
  if (usage.isHeld && (await $.clock.now()) >= usage.heldUntil) {
    usage.isHeld = false;
  }
  if (isOff || isBusy || isPolling || usage.isHeld || usage.isStopping) {
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
  const script = `const fs=require('fs'),p=require('path');const r=process.argv[1];const cut=Date.now()-${PRUNE_DAYS}*864e5;for(const d of ['sessions','inbox','usage'])for(const n of (fs.existsSync(p.join(r,d))?fs.readdirSync(p.join(r,d)):[])){const f=p.join(r,d,n);if(fs.statSync(f).mtimeMs<cut)fs.rmSync(f,{recursive:true,force:true})}`;
  await $.process.run(["node", "-e", script, root], { timeoutMs: 10_000 }).catch(() => {});
}

// ---- Usage guard ----

// Where this session stops now: its own point, the large-session point, or the account's.
function currentPoint() {
  return stopPoint({ account: usage.account, here: usage.here, large: usage.large, contextPercent: usage.contextPercent });
}

// The settings: CLAUDE_CROSSTALK_USAGE_STOP wins over setup.json's usageStop (0 = off).
async function loadGuard($) {
  const setup = await readJson($, `${root}/setup.json`, {});
  const fromEnv = parsePercent(await $.env.get("CLAUDE_CROSSTALK_USAGE_STOP"));
  usage.account = fromEnv ?? (Number.isInteger(setup.usageStop) ? setup.usageStop : USAGE_STOP);
  usage.large = setup.usageLarge === false ? null : { stop: setup.usageLarge?.stop ?? LARGE_STOP, context: setup.usageLarge?.context ?? LARGE_CONTEXT };
  usage.launch = Object.keys(setup.launch ?? {});
  return { setup, fromEnv };
}

// What this session's record says about its usage, for the move picker, list and send.
function usageRecord() {
  const w = usage.window;
  const stopAt = currentPoint().percent;
  if (!w) {
    return usage.isHeld ? { isHeld: true, stopAt } : undefined;
  }
  return { kind: w.kind, percent: w.percentUsed, resetsAt: w.resetsAt, stopAt, isHeld: usage.isHeld };
}

async function readFlags($) {
  const entries = await $.fs.list(`${root}/usage`).catch(() => []);
  const flags = await Promise.all(entries.filter((f) => f.name.endsWith(".json")).map((f) => readJson($, `${root}/usage/${f.name}`, null)));
  return flags.filter((f) => f && typeof f.profile === "string");
}

// After a measurement: over this session's point, stop it. At the account's point every session
// on the account is told, through a flag; a session's own lower point stops it alone.
async function checkUsage($) {
  const w = usage.window;
  if (!isOver(w, currentPoint().percent) || usage.handled.has(windowKey(w)) || usage.isStopping) {
    return;
  }
  if (isOver(w, usage.account)) {
    const flag = { profile: me.profile, account: me.account, kind: w.kind, percent: w.percentUsed, resetsAt: w.resetsAt, at: await $.clock.now(), by: me.address };
    await $.fs.write(`${root}/usage/${me.profile}.json`, JSON.stringify(flag, null, 2));
  }
  await stopForUsage($, { window: w });
}

// Every poll: a flag for this profile or account stops this session too, once per window.
async function checkFlags($) {
  if (usage.isStopping) {
    return;
  }
  const now = await $.clock.now();
  const flag = (await readFlags($)).find((f) => flagApplies(f, me, now) && !usage.handled.has(windowKey(f)));
  if (flag) {
    void stopForUsage($, { window: { kind: flag.kind, percentUsed: flag.percent, resetsAt: flag.resetsAt }, flagAt: flag.at }).catch(() => {});
  }
}

// Stop this session: hold wake-ups, end the running turn, compact, write the handoff, show the
// summary, then ask where to move it (or move it to stop.profile, typed with /crosstalk move).
async function stopForUsage($, stop) {
  if (usage.isStopping) {
    return;
  }
  usage.isStopping = true;
  try {
    const started = await $.clock.now();
    if (stop.window) {
      usage.handled.add(windowKey(stop.window));
      usage.isHeld = true;
      usage.heldUntil = flagEnds({ resetsAt: stop.window.resetsAt, at: stop.flagAt ?? started });
    }
    await beat($).catch(() => {});
    if (isBusy && mainTurn) {
      const ended = turnEnded;
      await $.turn.abort({ turnId: mainTurn }).catch(() => {});
      await Promise.race([ended, $.clock.sleep(ABORT_WAIT_MS)]);
    } else if (stop.profile) {
      await $.clock.sleep(MOVE_DELAY_MS);
    }
    let summary = "";
    try {
      summary = summaryOf(await $.session.compact({ instructions: COMPACT_INSTRUCTIONS }));
    } catch {
      // the handoff still points at the transcript
    }
    const now = await $.clock.now();
    const path = `${root}/handoffs/${handoffName(now, me.address)}`;
    await $.fs.write(path, handoffText({ me, stop, summary, transcript: titling?.transcript ?? "", now }));
    // Build choice: the new session works alone when the origin stopped near its limit, as the
    // origin is paused and a report back could go unanswered or spend what it has left.
    const alone = Boolean(stop.window) || isOver(usage.window, currentPoint().percent);
    const what = stop.window ? `${me.profile} is at ${stopReason(stop)}. This session is stopped and` : `Moving to ${stop.profile}: this session is`;
    $.ui.log(`Crosstalk: ${what} ${summary ? "compacted" : "not compacted (the summary couldn't be made)"}. Handoff: ${path}${summary ? `\n\n${summary}` : ""}`);
    if (stop.window) {
      void $.ui.notify(`${me.title || me.address} stopped at ${stopReason(stop)}. Move it to another account?`, { title: "Crosstalk" }).catch(() => {});
    }
    const profile = stop.profile ?? (await askMove($, stop, now));
    if (!profile) {
      return;
    }
    const opened = await openSession($, profile, resumePrompt(path, me, alone));
    $.ui.log(`Crosstalk: ${opened.error ?? opened.text}`);
  } finally {
    usage.isStopping = false;
  }
}

// Ask where to move: up to three other profiles, lowest usage first, or Not now.
async function askMove($, stop, now) {
  const choices = moveChoices(await readSessions($), usage.launch, me, await readFlags($), now);
  const later = "/crosstalk move <profile> moves it whenever you like.";
  if (!choices.length) {
    $.ui.log(`Crosstalk: no other profile is known to move to. ${later} /crosstalk launch <profile> <command> adds one.`);
    return "";
  }
  let answer = "";
  try {
    answer = await $.ui.ask(`${me.profile} is at ${stopReason(stop)}. Move this session to another account?`, [...choices.map(choiceLabel), NOT_NOW]);
  } catch {
    $.ui.log(`Crosstalk: not moved. ${later}`);
    return "";
  }
  const profile = chosenProfile(answer, choices);
  if (!profile) {
    $.ui.log(`Crosstalk: left here, with wake-ups held until the limit resets. ${later}`);
  }
  return profile;
}

async function moveCommand($, profile) {
  if (!PROFILE_WORD.test(profile)) {
    return "Usage: /crosstalk move <profile>: compacts this session, writes a handoff and opens it on that profile, at any usage.";
  }
  if (profile === me.profile) {
    return `This session is already on ${profile}. Name another profile.`;
  }
  if (usage.isStopping) {
    return "This session is already stopping for a move.";
  }
  void stopForUsage($, { profile }).catch(() => {});
  return `Moving this session to ${profile}: compacting it first, then opening ${profile} on the handoff.`;
}

async function usageCommand($, words) {
  const verb = String(words[0] ?? "").toLowerCase();
  const { setup, fromEnv } = await loadGuard($);
  if (verb === "here") {
    const n = parsePercent(words[1]);
    if (n === null) {
      return "Usage: /crosstalk usage here <1-100|off>: this session alone stops at that point, such as 80 for a big session that needs room to hand off.";
    }
    usage.here = n;
    await beat($);
    void checkUsage($).catch(() => {});
    return n ? `This session stops at ${n}%.` : "This session stops at the usual point again.";
  }
  if (verb === "large") {
    const n = parsePercent(words[1]);
    const context = words[2] === undefined ? (setup.usageLarge?.context ?? LARGE_CONTEXT) : parsePercent(words[2]);
    if (n === null || !context) {
      return `Usage: /crosstalk usage large <1-100|off> [context %]: a session whose context is that full (default ${LARGE_CONTEXT}%) stops at that point instead.`;
    }
    setup.usageLarge = n ? { stop: n, context } : false;
    await saveSetup($, setup);
    await loadGuard($);
    return n ? `A session whose context is ${context}% full or more stops at ${n}%.` : "Large sessions stop at the account's point, like the rest.";
  }
  if (verb !== "") {
    const n = parsePercent(verb);
    if (n === null) {
      return "Usage: /crosstalk usage [<1-100|off> | here <n|off> | large <n|off> [context %]].";
    }
    setup.usageStop = n;
    await saveSetup($, setup);
    await loadGuard($);
    const wins = fromEnv !== null ? ` CLAUDE_CROSSTALK_USAGE_STOP=${fromEnv} still wins in sessions that have it.` : "";
    return (n ? `Every session on an account stops at ${n}% of a usage limit.` : "The usage guard is off.") + wins;
  }
  const now = await $.clock.now();
  const lines = [
    usage.account ? `Account stop point: ${usage.account}%${fromEnv !== null ? " (CLAUDE_CROSSTALK_USAGE_STOP)" : ""}.` : "Account stop point: off.",
    usage.large ? `Large sessions: stop at ${usage.large.stop}% once their context is ${usage.large.context}% full.` : "Large sessions: no earlier point.",
    stopLine(currentPoint(), usage.contextPercent),
    `This session: ${usagePhrase(usageRecord()) || "no reading yet (none off a subscription, or before the first response)"}.`,
  ];
  const others = (await readSessions($)).filter((r) => r.id !== me.id && isLive(r, now) && Number.isFinite(r.usage?.percent));
  for (const r of others) {
    lines.push(`  ${labelOf(r)}: ${Math.round(r.usage.percent)}% of its ${windowName(r.usage.kind)}${isPaused(r) ? ", paused" : ""}`);
  }
  for (const f of (await readFlags($)).filter((f) => now < flagEnds(f))) {
    lines.push(`  ${f.profile} reached ${Math.round(f.percent)}% of its ${windowName(f.kind)}; its sessions are held until ${new Date(flagEnds(f)).toISOString()}.`);
  }
  return lines.join("\n");
}
