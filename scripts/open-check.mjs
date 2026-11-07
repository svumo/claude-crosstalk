#!/usr/bin/env node
// Checks, for real, that `open` starts a terminal in the right folder on macOS or Linux, using the
// same commands Crosstalk builds (hooks/core.mjs). It needs no Claude Code login: the "profile"
// is a throwaway shortcut, claude-xtcheck, that writes the folder it started in to a file.
//
//   node scripts/open-check.mjs                    the terminal open would pick
//   node scripts/open-check.mjs --terminal xterm   a given Linux terminal (tmux, xterm, ...)
//
// The shortcut goes in your shell's startup file between marker lines and is taken out again
// afterwards, however the check ends. The test folder's name has a quote, a space, $ and &, so
// quoting is checked too. Exit code 0 means the terminal opened in the right folder.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const core = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "core.mjs")).href);

const COMMAND = "claude-xtcheck";
const WAIT_MS = 45_000;
const START = "# >>> crosstalk open-check (temporary) >>>";
const END = "# <<< crosstalk open-check (temporary) <<<";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const run = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 30_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The startup file the new terminal's shell reads.
function rcFile(isMac, shell) {
  const name = basename(shell);
  if (name === "zsh") {
    return join(homedir(), ".zshrc");
  }
  if (name === "bash") {
    return join(homedir(), isMac ? ".bash_profile" : ".bashrc");
  }
  return join(homedir(), ".profile");
}

function withoutBlock(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  return start >= 0 && end > start ? text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, "") : text;
}

async function main() {
  const isMac = process.platform === "darwin";
  if (!isMac && process.platform !== "linux") {
    console.log("This check is for macOS and Linux. On Windows, open uses Windows Terminal (windowArgv).");
    return 2;
  }
  if (!core.isSafeLaunch(COMMAND)) {
    throw new Error(`${COMMAND} doesn't pass isSafeLaunch`);
  }
  const shell = core.userShell(process.env.SHELL);
  const box = mkdtempSync(join(tmpdir(), "xt-"));
  const folder = join(box, "it's a dir $HOME & co");
  mkdirSync(folder);
  const marker = join(box, "landed");
  const rc = rcFile(isMac, shell);
  const before = existsSync(rc) ? readFileSync(rc, "utf8") : null;
  const startedTmux = [];

  try {
    // The throwaway shortcut, in the shell's startup file.
    const fn = `${COMMAND}() { pwd > ${core.shQuote(marker)}; }`;
    writeFileSync(rc, `${withoutBlock(before ?? "").replace(/\s*$/, "\n")}${START}\n${fn}\n${END}\n`);

    let argv;
    let what;
    if (isMac) {
      argv = core.macArgv(folder, COMMAND);
      what = "Terminal";
    } else {
      const wanted = arg("--terminal") ?? process.env.CLAUDE_CROSSTALK_TERMINAL;
      const candidates = core.linuxCandidates({
        wanted,
        inTmux: Boolean(process.env.TMUX) || wanted === "tmux",
        hasDisplay: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
      });
      const found = candidates.length ? run(core.whichArgv(candidates)).stdout.trim() : "";
      if (!core.LINUX_TERMINALS.includes(found)) {
        console.log(`FAIL: no terminal found. Looked for: ${candidates.join(", ") || "none (no display, not in tmux)"}`);
        return 1;
      }
      if (wanted && found !== wanted.toLowerCase()) {
        console.log(`FAIL: asked for ${wanted}, but it isn't installed (found ${found})`);
        return 1;
      }
      // Outside tmux, a server has to be running for new-window to land in.
      if (found === "tmux" && !process.env.TMUX) {
        const session = `xtcheck-${process.pid}`;
        run(["tmux", "new-session", "-d", "-s", session]);
        startedTmux.push(session);
      }
      argv = core.linuxArgv(found, folder, COMMAND, shell);
      what = found;
    }

    console.log(`Opening ${what} in: ${folder}`);
    console.log(`argv: ${JSON.stringify(argv)}`);
    const ran = run(argv);
    if (ran.status !== 0) {
      console.log(`FAIL: ${what} didn't start (exit ${ran.status}): ${(ran.stderr || ran.error?.message || "").trim()}`);
      return 1;
    }
    const until = Date.now() + WAIT_MS;
    while (!existsSync(marker) && Date.now() < until) {
      await sleep(250);
    }
    if (!existsSync(marker)) {
      console.log(`FAIL: ${what} opened, but ${COMMAND} didn't run within ${WAIT_MS / 1000}s (the shell may not have read ${rc})`);
      return 1;
    }
    const landed = readFileSync(marker, "utf8").trim();
    const isRight = realpathSync(landed) === realpathSync(folder);
    console.log(`${isRight ? "PASS" : "FAIL"}: ${what} started ${COMMAND} in ${landed}`);
    return isRight ? 0 : 1;
  } finally {
    if (before === null) {
      rmSync(rc, { force: true });
    } else {
      writeFileSync(rc, before);
    }
    for (const session of startedTmux) {
      run(["tmux", "kill-session", "-t", session]);
    }
    rmSync(box, { recursive: true, force: true });
  }
}

process.exitCode = await main();
