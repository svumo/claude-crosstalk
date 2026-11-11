// The sidecar as a Crosstalk peer: it keeps a session record like any Claude session's, reads its
// own inbox, and writes into other sessions' inboxes. The folder layout is hooks/crosstalk.mjs's.

import { readJson, listNames, privateDir, writeJson } from "./files.ts";

const BEAT_MS = 15_000;

export type PeerRecord = { id: string; profile: string; address: string; alias: string; cwd: string; title: string; startedAt: number };

export class Peer {
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private readonly root: string;
  readonly record: PeerRecord;

  constructor(root: string, record: PeerRecord) {
    this.root = root.replace(/\\/g, "/").replace(/\/+$/, "");
    this.record = record;
  }

  start(): void {
    privateDir(`${this.root}/sessions`);
    privateDir(`${this.root}/inbox/${this.record.id}`);
    this.beat();
    this.timer = setInterval(() => this.beat(), BEAT_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.beat({ endedAt: Date.now() });
  }

  private beat(extra: Record<string, number> = {}): void {
    writeJson(`${this.root}/sessions/${this.record.id}.json`, { ...this.record, seenAt: Date.now(), ...extra });
  }

  // Puts a message in another session's inbox, under a name that sorts by time.
  send(toId: string, message: { sent_at: number }): void {
    const folder = `${this.root}/inbox/${toId}`;
    privateDir(folder);
    const name = `${String(message.sent_at).padStart(15, "0")}-${Math.random().toString(36).slice(2, 10)}.json`;
    writeJson(`${folder}/${name}`, message);
  }

  // The messages that have arrived since the last call, oldest first, as they were written.
  // A file that does not parse yet is left for the next call.
  arrivals(): unknown[] {
    const folder = `${this.root}/inbox/${this.record.id}`;
    const fresh: unknown[] = [];
    for (const name of listNames(folder)) {
      if (!name.endsWith(".json") || name.startsWith("_") || this.seen.has(name)) {
        continue;
      }
      const value = readJson(`${folder}/${name}`);
      if (value !== null) {
        this.seen.add(name);
        fresh.push(value);
      }
    }
    return fresh;
  }
}
