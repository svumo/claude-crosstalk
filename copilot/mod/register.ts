// The Copilot part of Crosstalk's hooks module: the /crosstalk-gh command and what follows from it.
//
// hooks.json names a single module, and the engine takes one unmatched hook per event across that
// module and everything it imports. So hooks/crosstalk.mjs keeps the session's own hooks and calls
// in here: registerCopilot(on) adds the hooks that carry a matcher, and startCopilot($, host) runs
// from its session.start.

import { isDirty } from "../context/git.ts";
import { secretsIn } from "../context/minimise.ts";
import { taskId } from "../protocol/ids.ts";
import { taskPaths, tasksDir } from "../protocol/layout.ts";
import type { DecisionFile, ModeFile, TaskStateFile } from "../protocol/layout.ts";
import { parseQuota, QUOTA_ARGV, quotaLine } from "../protocol/quota.ts";
import type { Quota } from "../protocol/quota.ts";
import { isMode, makeEnvelope, MODES } from "../protocol/schema.ts";
import type { Decision, Mode, TaskBody } from "../protocol/schema.ts";
import { DEFAULT_CAPS } from "../sidecar/budget.ts";
import { HELP, isRunning, MODE_TEXT, parseCopilot, pickTask, statusLine } from "./args.ts";
import { captureContext } from "./capture.ts";
import type { Who } from "./capture.ts";
import { CLAUDE_TOOL, mayControl } from "./engine.ts";
import type { Engine, On, Origin, SubmitInput } from "./engine.ts";
import { blockBars, COPILOT_ROW_KEY, intoBand, isLive, PALETTE, pickShown, ringLabel, ringLine, ringPercent, ringSvg, taskPieces, UNAVAILABLE } from "./meter.ts";
import type { Piece } from "./meter.ts";

// What Crosstalk hands over at session start: its shared folder, and this session as it is now.
export type Host = { root: string; who: () => (Who & { address: string }) | null };

// The slash command, and the tool that lets Claude run the same command line.
export const COMMAND = "crosstalk-gh";
export const GH_TOOL = "mcp__crosstalk__crosstalk_gh";
// What the tool adds to the command line: picture files, and the checkout to cut the task from.
type ToolInput = { images: string[]; folder: string };

const NODE_NEEDED = [22, 18] as const;
const SHOWN_TASKS = 10;
const TOUCHED_MAX = 400;

let host: Host | null = null;
// Files this session edited, newest last, for the context a task carries.
let touched: string[] = [];

// The Copilot row above the prompt. Task files are read every TICK_MS; GitHub's meter every
// minute while a task runs, else every ten (build choice: often enough to see it move, rarely
// enough that an idle session barely calls GitHub).
const TICK_MS = 15_000;
const LIVE_QUOTA_MS = 60_000;
const IDLE_QUOTA_MS = 10 * 60_000;
let quota: Quota | null = null;
let quotaFailed = false;
let quotaAt = -Infinity;
let shown: TaskStateFile | null = null;
let tickedAt = 0;
// The model new tasks use, from config.json ("" for none).
let configModel = "";
// The ring's last number, and when it changed: it fills in for RING_FILL_MS after a change.
const RING_FILL_MS = 1_000;
let ringShown = -1;
let ringChangedAt = 0;

async function readQuota($: Engine): Promise<Quota | null> {
  const ran = await $.process.run([...QUOTA_ARGV], { timeoutMs: 15_000 }).catch(() => null);
  return ran && ran.exitCode === 0 ? parseQuota(ran.stdout) : null;
}

// Reads this session's tasks, and GitHub's meter when it is due (or `force`), then redraws.
async function tick($: Engine, force = false): Promise<void> {
  const me = host?.who() ?? null;
  if (!host || !me) {
    return;
  }
  const now = await $.clock.now();
  tickedAt = now;
  shown = pickShown(await readStates($, host.root, me.id), now);
  const saved = (await readConfig($, host.root)).model;
  configModel = typeof saved === "string" ? saved : "";
  if (force || now - quotaAt >= (isLive(shown) ? LIVE_QUOTA_MS : IDLE_QUOTA_MS)) {
    quotaAt = now;
    const read = await readQuota($);
    if (read) {
      quota = read;
    }
    quotaFailed = read === null && quota === null;
  }
  $.ui.invalidate("ui.render");
}

function noteEdit(path: unknown): void {
  if (typeof path === "string" && path !== "") {
    touched = [...touched.filter((p) => p !== path), path].slice(-TOUCHED_MAX);
  }
}

export function registerCopilot(on: On): void {
  on("command.run", { command: COMMAND }, async ($, e) => ({ text: await copilotCommand($, String(e.args ?? ""), e.origin) }));

  on("tool.call", { tool: GH_TOOL }, async ($, e) => {
    const images = Array.isArray(e.images) ? e.images.map(String).filter((p) => p !== "") : [];
    return { result: await copilotCommand($, String(e.args ?? ""), CLAUDE_TOOL, { images, folder: typeof e.folder === "string" ? e.folder.trim() : "" }) };
  });

  on("tool.call", { tool: "Edit" }, async (_$, e, next) => {
    noteEdit(e.file_path);
    return next(e);
  });

  on("tool.call", { tool: "Write" }, async (_$, e, next) => {
    noteEdit(e.file_path);
    return next(e);
  });

  on("tool.call", { tool: "NotebookEdit" }, async (_$, e, next) => {
    noteEdit(e.notebook_path);
    return next(e);
  });

  // Stacks under whatever else draws above the prompt (the skins meters, token-ledger), so the
  // order mods load in does not matter.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const theirs = await next(e);
    if (e.props?.hasSurvey || (!quota && !quotaFailed && !shown)) {
      return e.surface === "terminal" ? blockBars(theirs) : theirs;
    }
    const ui = $.ui.resolve(e);
    const { Box, Text } = ui;
    const pieces = (list: Piece[]) => Box({
      flexDirection: "row", columnGap: 1, flexShrink: 0,
      children: list.map((p) => Text({ color: p.color, bold: p.bold === true, children: p.text })),
    });
    const mine: unknown[] = [];
    if (quota) {
      const percent = Math.round(ringPercent(quota));
      const now = await $.clock.now();
      if (percent !== ringShown) {
        ringShown = percent;
        ringChangedAt = now;
      }
      // Fills in when it first draws and when the number moves, like skins' rings; settled between.
      const animate = now - ringChangedAt < RING_FILL_MS;
      // The terminal draws Svg as nothing, so it gets skins' text meter there.
      // Short, to save room on the row: `11% gh · reset 1 Dec` (build choice: gh, as the meter is
      // GitHub's), the day GitHub's monthly allowance starts again.
      const label = ringLabel(quota, (isLive(shown) && shown?.model) || configModel);
      if (e.surface !== "terminal" && ui.Svg) {
        const ring = ringSvg(percent, label, animate);
        mine.push(ui.Svg({ key: "usage-copilot", source: ring.source, alt: ring.alt, width: ring.width, height: ring.height }));
      } else {
        const line = ringLine(percent, label);
        mine.push(Text({ color: PALETTE.muted, children: [Text({ color: line.color, children: line.bar }), ` ${line.text}`] }));
      }
    } else if (quotaFailed) {
      mine.push(pieces([UNAVAILABLE]));
    }
    if (shown) {
      mine.push(pieces(taskPieces(shown, tickedAt, e.props?.bodyColumns ?? 80)));
    }
    // Among skins' context / 5h / 7d rings when its band is drawn; else a row of its own. In the
    // terminal skins' bars are redrawn in the same blocks as Copilot's.
    const base = e.surface === "terminal" ? blockBars(theirs) : theirs;
    const joined = intoBand(base, mine);
    if (joined.joined) {
      return joined.node;
    }
    // Keyed, so a mod drawn around this one (token-ledger) can lift it into the skins band when
    // skins draws its band after this hook and the join above found nothing.
    const row = Box({ key: COPILOT_ROW_KEY, paddingX: 1, flexDirection: "row", alignItems: "center", columnGap: 3, children: mine });
    return base ? Box({ flexDirection: "column", children: [base, row] }) : row;
  });
}

export async function startCopilot($: Engine, given: Host): Promise<void> {
  host = given;
  touched = [];
  await $.command.register({
    name: COMMAND,
    description: "Hands a task to GitHub Copilot CLI in its own git worktree. --bypass/--auto set how much it asks; mode and models pick defaults; status shows tasks; stop ends one.",
    argumentHint: "[--bypass|--auto|--model <id>] <task> | mode [ask|auto|bypass] | models | model <id> | status | stop | setup",
  });
  await $.tool.register({
    name: "crosstalk_gh",
    description: "Run a /crosstalk-gh command, which drives GitHub Copilot CLI. `args` is everything after /crosstalk-gh: a task to hand Copilot (it runs in its own git worktree and branch cut from this session's branch, and the result comes back as a Crosstalk message), optionally led by --bypass, --auto, --mode <mode> or --model <id>; or one of: status, stop [task], mode <ask|auto|bypass> [task], models, model <id|default>, approve|allow|deny <request> [task], setup, help.",
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "string", description: "Everything after /crosstalk-gh, e.g. \"status\" or \"--bypass fix the login bug\"" },
        images: { type: "array", items: { type: "string" }, description: "With a task: absolute paths of up to 10 png, jpg, gif or webp pictures for Copilot. They are put in its worktree and Copilot is told to open them." },
        folder: { type: "string", description: "With a task: the git checkout to cut Copilot's branch from, such as the worktree you are working in. Leave it out for the folder this session started in." },
      },
      required: ["args"],
    },
    isDeferred: false,
  });
  quota = null;
  quotaFailed = false;
  quotaAt = -Infinity;
  shown = null;
  ringShown = -1;
  $.clock.every(TICK_MS, () => tick($).catch(() => {}));
  void tick($, true).catch(() => {});
}

async function readJson($: Engine, path: string): Promise<unknown> {
  try {
    return JSON.parse(await $.fs.read(path));
  } catch {
    return null;
  }
}

// This session's tasks, newest first.
async function readStates($: Engine, root: string, sessionId: string): Promise<TaskStateFile[]> {
  const entries = await $.fs.list(tasksDir(root)).catch(() => []);
  const states: TaskStateFile[] = [];
  for (const entry of entries.filter((e) => e.kind === "dir")) {
    const state = (await readJson($, taskPaths(root, entry.name).state)) as TaskStateFile | null;
    if (state && state.origin_id === sessionId && typeof state.started_at === "number" && Array.isArray(state.pending)) {
      states.push(state);
    }
  }
  return states.sort((a, b) => b.started_at - a.started_at);
}

async function nodeFault($: Engine): Promise<string> {
  const ran = await $.process.run(["node", "--version"], { timeoutMs: 15_000 }).catch(() => null);
  const match = /^v(\d+)\.(\d+)\./.exec(ran?.stdout.trim() ?? "");
  const need = `Copilot tasks run on Node.js ${NODE_NEEDED.join(".")} or newer`;
  if (!ran || ran.exitCode !== 0 || !match) {
    return `${need}, and \`node\` was not found. Install it from nodejs.org, then try again.`;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const isEnough = major > NODE_NEEDED[0] || (major === NODE_NEEDED[0] && minor >= NODE_NEEDED[1]);
  return isEnough ? "" : `${need}; this computer has ${ran.stdout.trim()}.`;
}

async function handOver($: Engine, root: string, me: Who & { address: string }, task: string, picked: { mode?: Mode; model?: string } = {}, fromTool?: ToolInput): Promise<string> {
  const secrets = secretsIn(task);
  if (secrets.length > 0) {
    return `Not sent: the task holds what looks like ${secrets.join(" and ")}. Take it out and try again.`;
  }
  const fault = await nodeFault($);
  if (fault !== "") {
    return fault;
  }
  const captured = await captureContext($, me, touched, fromTool?.folder ?? "");
  if (!captured.context) {
    return captured.error ?? "This session's context could not be read.";
  }
  const { context } = captured;
  const id = taskId(task, Math.random().toString(36).slice(2));
  const paths = taskPaths(root, id);
  const sentAt = await $.clock.now();
  // Writes the handoff and starts the sidecar; "" when it started, else why not.
  const launch = async (images: string[]): Promise<string> => {
    const envelope = makeEnvelope<TaskBody>({
      id: `${id}-task`, thread_id: id, from: me.address, fromId: me.id, ...(me.title ? { fromTitle: me.title } : {}), to: `copilot/${id}`,
      sent_at: sentAt, kind: "task", body: { task_id: id, task, ...picked, ...(images.length > 0 ? { images } : {}) }, text: `Task for Copilot: ${task}`,
      context: context as unknown as Record<string, unknown>, caps: DEFAULT_CAPS,
    });
    await $.fs.write(paths.task, JSON.stringify(envelope, null, 2));
    const started = await $.process.run(["node", `${$.plugin.root}/copilot/sidecar/main.ts`, "start", id, "--root", root], { timeoutMs: 30_000 }).catch(() => null);
    return started && started.exitCode === 0 ? "" : `Couldn't start Copilot task ${id}${started?.stderr ? `: ${started.stderr.trim().slice(0, 300)}` : "."}`;
  };
  if (fromTool) {
    // Nothing is pasted with a tool call, so the task starts now, with any pictures it names.
    const saved = await copyPictures($, paths.attachments, fromTool.images);
    if (saved.error) {
      return saved.error;
    }
    const failed = await launch(saved.names);
    if (failed !== "") {
      return failed;
    }
  } else {
    // Pictures pasted with the command reach prompt.submit, which runs after this command has
    // answered; so the start waits for it (copilotSubmit), or for the timer when it never comes.
    holdLaunch($, launch, paths.attachments);
  }
  const dirty = context.git.dirty.staged + context.git.dirty.unstaged + context.git.dirty.untracked;
  const config = await readConfig($, root);
  const mode = picked.mode ?? (isMode(config.mode) ? config.mode : "ask");
  const model = picked.model ?? (typeof config.model === "string" && config.model !== "" ? config.model : "");
  const lines = [`Copilot task ${id} started in ${mode} mode${model ? ` on ${model}` : ""}, on branch copilot/${id} from ${context.git.branch || context.git.head_sha.slice(0, 12)}. The result arrives as a Crosstalk message.`];
  if (isDirty(context.git)) {
    lines.push(`Your uncommitted changes (${dirty} ${dirty === 1 ? "file" : "files"}) aren't in its worktree, which is cut from the last commit.`);
  }
  return lines.join("\n");
}

// A /crosstalk-gh task waiting for the prompt.submit that follows its command, where pasted pictures
// can be read. IMAGE_WAIT_MS is long enough for that event, short enough not to be noticed (build choice).
const IMAGE_WAIT_MS = 2_500;
const IMAGES_MAX = 10;
const IMAGE_BYTES_MAX = 20 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
type Held = { launch: (images: string[]) => Promise<string>; dir: string; timer: { cancel(): void } | null };
let held: Held | null = null;

// Starts a held task and says so only if it failed (the command's answer already said it started).
function release($: Engine, task: Held, images: string[]): void {
  task.timer?.cancel();
  void task.launch(images).then((failed) => {
    if (failed !== "") {
      $.ui.toast(failed);
    } else if (images.length > 0) {
      $.ui.toast(`Copilot got ${images.length === 1 ? "the pasted picture" : `${images.length} pasted pictures`} with the task.`);
    }
  }).catch((error) => $.ui.toast(`Couldn't start the Copilot task: ${error instanceof Error ? error.message : String(error)}`));
}

function holdLaunch($: Engine, launch: Held["launch"], dir: string): void {
  if (held) {
    const before = held;
    held = null;
    release($, before, []);
  }
  const task: Held = { launch, dir, timer: null };
  held = task;
  task.timer = $.clock.after(IMAGE_WAIT_MS, () => {
    if (held === task) {
      held = null;
      release($, task, []);
    }
  });
}

// Node writes a picture file as base64, so no image bytes pass through the engine's text calls.
const TO_BASE64 = "const fs=require('fs'),path=require('path');const [src,out]=process.argv.slice(1);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,fs.readFileSync(src).toString('base64'))";

// Copies picture files named by Claude's tool into the task's attachments folder, as savePictures
// does for pasted ones. Returns the names saved (`1.png`), or why one could not be used.
async function copyPictures($: Engine, dir: string, files: string[]): Promise<{ names: string[]; error?: string }> {
  if (files.length > IMAGES_MAX) {
    return { names: [], error: `Not sent: ${files.length} pictures; the most is ${IMAGES_MAX}.` };
  }
  const names: string[] = [];
  for (const file of files) {
    const ext = /\.(png|jpe?g|gif|webp)$/i.exec(file)?.[1]?.toLowerCase().replace("jpeg", "jpg");
    if (!ext) {
      return { names: [], error: `Not sent: ${file} is not a png, jpg, gif or webp picture.` };
    }
    const info = await $.fs.stat(file).catch(() => null);
    if (!info || info.kind !== "file") {
      return { names: [], error: `Not sent: there is no picture at ${file}.` };
    }
    if (info.size > IMAGE_BYTES_MAX) {
      return { names: [], error: `Not sent: ${file} is over ${IMAGE_BYTES_MAX / 1024 / 1024} MB.` };
    }
    const name = `${names.length + 1}.${ext}`;
    const ran = await $.process.run(["node", "-e", TO_BASE64, file, `${dir}/${name}.b64`], { timeoutMs: 30_000 }).catch(() => null);
    if (!ran || ran.exitCode !== 0) {
      return { names: [], error: `Not sent: ${file} could not be read.` };
    }
    names.push(name);
  }
  return { names };
}

// Saves each pasted picture as base64 in the task's attachments folder; the sidecar decodes it
// into the worktree. Returns the names saved (`1.png`).
async function savePictures($: Engine, dir: string, attachments: SubmitInput["attachments"]): Promise<string[]> {
  const names: string[] = [];
  let total = 0;
  for (const item of attachments ?? []) {
    if (item.type !== "image" || !item.id || names.length >= IMAGES_MAX) {
      continue;
    }
    let base64 = "";
    let mediaType = item.mediaType ?? "";
    let offset: number | undefined;
    let ok = true;
    do {
      const slice = await $.prompt.media({ id: item.id, ...(offset !== undefined ? { offset } : {}) }).catch(() => null);
      if (!slice || slice.base64 === undefined) {
        ok = false;
        break;
      }
      base64 += slice.base64;
      mediaType = slice.mediaType || mediaType;
      total += slice.base64.length * 0.75;
      offset = slice.next;
    } while (offset !== undefined && total <= IMAGE_BYTES_MAX);
    if (!ok || total > IMAGE_BYTES_MAX) {
      continue;
    }
    const name = `${names.length + 1}.${IMAGE_EXT[mediaType.toLowerCase()] ?? "png"}`;
    await $.fs.write(`${dir}/${name}.b64`, base64);
    names.push(name);
  }
  return names;
}

// Called from Crosstalk's prompt.submit hook: the /crosstalk-gh line's own submission carries what was
// pasted with it. Media can only be read while that hook runs, so this waits for the reads.
export async function copilotSubmit($: Engine, e: SubmitInput): Promise<void> {
  if (!held || e.command?.name !== COMMAND) {
    return;
  }
  const task = held;
  held = null;
  task.timer?.cancel();
  const images = (e.attachments ?? []).some((a) => a.type === "image")
    ? await savePictures($, task.dir, e.attachments).catch(() => [])
    : [];
  release($, task, images);
}

async function decide($: Engine, root: string, sessionId: string, decision: Decision, requestId: string, named: string, origin: Origin): Promise<string> {
  if (!mayControl(origin)) {
    return "Only you can answer Copilot's requests: type the command yourself.";
  }
  const picked = pickTask(await readStates($, root, sessionId), named, (s) => s.pending.includes(requestId), `is waiting on ${requestId}`);
  if (!picked.state) {
    return picked.error ?? "";
  }
  if (!picked.state.pending.includes(requestId)) {
    return `${picked.state.task_id} is not waiting on ${requestId}. /crosstalk-gh status shows what it is waiting on.`;
  }
  const answer: DecisionFile = { request_id: requestId, decision, decided_by: "command", at: await $.clock.now() };
  await $.fs.write(`${taskPaths(root, picked.state.task_id).decisions}/${requestId}.json`, JSON.stringify(answer));
  const said = { approve: "Approved", allow_task: "Allowed for the rest of the task", deny: "Denied" }[decision];
  return `${said}: ${requestId} of ${picked.state.task_id}.`;
}

async function stop($: Engine, root: string, sessionId: string, named: string): Promise<string> {
  const picked = pickTask(await readStates($, root, sessionId), named, isRunning, "is running");
  if (!picked.state) {
    return picked.error ?? "";
  }
  if (!isRunning(picked.state)) {
    return `${picked.state.task_id} has already ended (${picked.state.state}).`;
  }
  await $.fs.write(taskPaths(root, picked.state.task_id).stop, "stop\n");
  return `Stopping ${picked.state.task_id}. Its branch and worktree are kept; the reply says how to discard them.`;
}

// Installing software is the person's call, so only a command they typed runs it (build choice).
async function runSetup($: Engine, root: string, origin: Origin): Promise<string> {
  if (!mayControl(origin)) {
    return "Only you can run /crosstalk-gh setup: type the command yourself.";
  }
  const fault = await nodeFault($);
  if (fault !== "") {
    return fault;
  }
  const ran = await $.process.run(["node", `${$.plugin.root}/copilot/sidecar/main.ts`, "setup", "--root", root], { timeoutMs: 300_000 }).catch(() => null);
  if (!ran) {
    return "Couldn't run Copilot setup.";
  }
  return (ran.stdout.trim() || ran.stderr.trim().slice(0, 600) || (ran.exitCode === 0 ? "Copilot setup finished." : "Copilot setup failed."));
}

// The sidecar's settings file, which the mode and model commands write into, keeping the rest.
const configPath = (root: string): string => `${root}/copilot/config.json`;

async function readConfig($: Engine, root: string): Promise<Record<string, unknown>> {
  const saved = await readJson($, configPath(root));
  return typeof saved === "object" && saved !== null && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
}

async function writeConfig($: Engine, root: string, change: Record<string, unknown>): Promise<void> {
  await $.fs.write(configPath(root), JSON.stringify({ ...(await readConfig($, root)), ...change }, null, 2));
}

const MODE_LABEL: Record<Mode, string> = { ask: "Ask", auto: "Auto", bypass: "Bypass" };

function modeList(current: Mode): string {
  return [`Copilot mode now: ${current}.`, ...MODES.map((m) => `  ${m === current ? "●" : "○"} ${m}: ${MODE_TEXT[m]}`), "Change it: /crosstalk-gh mode <mode> [task], or /crosstalk-gh --<mode> <task> for one task."].join("\n");
}

// Sets the mode new tasks start in and switches this session's running tasks (or the one named).
// Handing out approvals is the person's call, so only a command they typed does it.
async function setMode($: Engine, root: string, sessionId: string, mode: Mode | "", named: string, origin: Origin): Promise<string> {
  if (!mayControl(origin)) {
    return "Only you can change Copilot's mode: type the command yourself.";
  }
  const saved = (await readConfig($, root)).mode;
  const current: Mode = isMode(saved) ? saved : "ask";
  let chosen = mode;
  if (chosen === "") {
    const answer = await $.ui.ask(`Which mode should Copilot tasks run in? Now: ${current}.`, {
      header: "Copilot mode",
      options: MODES.map((m) => MODE_LABEL[m]),
    }).catch(() => "");
    chosen = MODES.find((m) => MODE_LABEL[m] === answer || m === answer.trim().toLowerCase()) ?? "";
    if (chosen === "") {
      return modeList(current);
    }
  }
  const states = await readStates($, root, sessionId);
  const targets = named === "" ? states.filter(isRunning) : states.filter((s) => s.task_id === named);
  if (named !== "" && targets.length === 0) {
    return `This session has no task ${named}. /crosstalk-gh status shows them.`;
  }
  const now = await $.clock.now();
  for (const state of targets.filter(isRunning)) {
    const file: ModeFile = { mode: chosen, at: now };
    await $.fs.write(taskPaths(root, state.task_id).mode, JSON.stringify(file));
  }
  if (named === "") {
    await writeConfig($, root, { mode: chosen });
  }
  const switched = targets.filter(isRunning).map((s) => s.task_id);
  const scope = named === "" ? "New tasks start in it" : `Set for ${named} only`;
  const running = switched.length > 0 && named === "" ? `; switched ${switched.length === 1 ? "the running task" : `${switched.length} running tasks`} too` : "";
  void tick($).catch(() => {});
  return `Copilot mode: ${chosen}, ${MODE_TEXT[chosen]}. ${scope}${running}.`;
}

type ModelsAnswer = { ok: true; models: { id: string; name: string; multiplier: number | null; enabled: boolean }[]; default: string } | { ok: false; error: string };

async function readModels($: Engine, root: string): Promise<ModelsAnswer> {
  const ran = await $.process.run(["node", `${$.plugin.root}/copilot/sidecar/main.ts`, "models", "--root", root], { timeoutMs: 60_000 }).catch(() => null);
  try {
    return JSON.parse(ran?.stdout.trim() ?? "") as ModelsAnswer;
  } catch {
    return { ok: false, error: ran?.stderr.trim().slice(0, 300) || "the model list could not be read" };
  }
}

async function listModels($: Engine, root: string): Promise<string> {
  const read = await readModels($, root);
  if (!read.ok) {
    return `Couldn't list Copilot's models: ${read.error}.`;
  }
  const width = Math.max(...read.models.map((m) => m.id.length));
  const rows = read.models.map((m) => {
    const price = m.multiplier === null ? "" : `  ${m.multiplier}x`;
    const mark = m.id === read.default ? "  ← default" : "";
    return `  ${m.id.padEnd(width)}  ${m.name}${price}${m.enabled ? "" : "  (turned off for this account)"}${mark}`;
  });
  const now = read.default === "" ? "New tasks use Copilot's own default." : `New tasks use ${read.default}.`;
  return [`Copilot models (${read.models.length}). ${now}`, ...rows, "Pick one: /crosstalk-gh model <id>, or /crosstalk-gh --model <id> <task> for one task."].join("\n");
}

async function setModel($: Engine, root: string, model: string, origin: Origin): Promise<string> {
  if (!mayControl(origin)) {
    return "Only you can change Copilot's model: type the command yourself.";
  }
  const read = await readModels($, root);
  if (read.ok && model !== "default" && !read.models.some((m) => m.id === model)) {
    return `Copilot has no model ${model}. /crosstalk-gh models lists them.`;
  }
  await writeConfig($, root, { model: model === "default" ? "" : model });
  void tick($).catch(() => {}); // the meter names the new model now, not at the next tick
  return model === "default" ? "New Copilot tasks use Copilot's own default model." : `New Copilot tasks use ${model}.`;
}

async function copilotCommand($: Engine, args: string, origin: Origin, fromTool?: ToolInput): Promise<string> {
  const me = host?.who() ?? null;
  if (!host || !me) {
    return "Crosstalk did not start in this session.";
  }
  const command = parseCopilot(args);
  switch (command.verb) {
    case "help":
      return HELP;
    case "status": {
      const states = await readStates($, host.root, me.id);
      const now = await $.clock.now();
      const fresh = await readQuota($);
      if (fresh) {
        quota = fresh;
        quotaAt = now;
        quotaFailed = false;
      }
      const meter = fresh ? quotaLine(fresh) : "GitHub's Copilot meter could not be read (gh api copilot_internal/user failed; is gh signed in?).";
      const tasks = states.length === 0 ? "This session has handed Copilot no tasks. /crosstalk-gh <task> starts one." : states.slice(0, SHOWN_TASKS).map((s) => statusLine(s, now)).join("\n");
      return `${tasks}\n${meter}`;
    }
    case "setup":
      return runSetup($, host.root, origin);
    case "decide":
      return decide($, host.root, me.id, command.decision, command.requestId, command.taskId, origin);
    case "stop":
      return stop($, host.root, me.id, command.taskId);
    case "mode":
      return setMode($, host.root, me.id, command.mode, command.taskId, origin);
    case "models":
      return listModels($, host.root);
    case "model":
      return setModel($, host.root, command.model, origin);
    case "error":
      return command.text;
    case "task":
      if ((command.mode || command.model) && !mayControl(origin)) {
        return "Only you can pick a Copilot task's mode or model: type the command yourself.";
      }
      return handOver($, host.root, me, command.task, { ...(command.mode ? { mode: command.mode } : {}), ...(command.model ? { model: command.model } : {}) }, fromTool);
  }
}
