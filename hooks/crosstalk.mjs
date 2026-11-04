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
// it when it ends. wakeLimit stops two sessions replying to each other for ever.
//
// The host reads on(...) and $.noun.method(...) from source, so they are spelled literally, and
// helpers that take $ are top-level functions.

import {
  addressOf, frameMessages, isLive, MAX_TEXT, mayWake, messageFileName,
  pendingNames, profileName, resolveTarget, toolResultCount, toolUseCount,
} from "./core.mjs";

const POLL_MS = 3_000;
const BEAT_MS = 15_000;
const BAD_TRIES = 20;
const PRUNE_DAYS = 7;
const SEND = "mcp__crosstalk__send";
const LIST = "mcp__crosstalk__list";

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

export function register(on, options) {
  const wanted = Number(options?.wakeLimit);
  limit = wanted > 0 ? wanted : 25;

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
    const word = String(e.args ?? "").trim().toLowerCase();
    if (word === "off" || word === "on") {
      isOff = word === "off";
      return { text: isOff ? "Crosstalk off: messages wait until you turn it on." : "Crosstalk on." };
    }
    if (!me) {
      return { text: "Crosstalk did not start in this session." };
    }
    const now = await $.clock.now();
    const others = (await readSessions($)).filter((r) => r.id !== me.id && isLive(r, now)).map((r) => r.address);
    return { text: `You are ${me.address}${isOff ? " (off)" : ""}. Others running: ${others.join(", ") || "none"}. Wake-ups since you last typed: ${wakes} of ${limit}.` };
  });
}

function failed(text) {
  return { deny: text }; // the model reads it as the tool's error
}

function notReady() {
  return failed("Crosstalk did not start in this session.");
}

async function startUp($) {
  const home = (await $.env.get("USERPROFILE")) ?? (await $.env.get("HOME"));
  const folder = await $.env.get("CLAUDE_CROSSTALK_DIR");
  if (!folder && !home) {
    throw new Error("no home folder");
  }
  root = (folder || `${home}/.claude-crosstalk`).replace(/\\/g, "/").replace(/\/+$/, "");
  const profile = profileName(await $.env.get("CLAUDE_CROSSTALK_NAME"), await $.env.get("CLAUDE_CONFIG_DIR"), $.plugin.root);
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
  await $.command.register({ name: "crosstalk", description: "Shows who Crosstalk can reach. /crosstalk off or /crosstalk on pauses it." });
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

function noteArrival($, batch) {
  const from = [...new Set(batch.map((m) => m.from))].join(", ");
  $.ui.toast(`Crosstalk: ${batch.length === 1 ? "a message" : `${batch.length} messages`} from ${from}`);
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
