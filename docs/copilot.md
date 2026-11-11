# Handing tasks to GitHub Copilot CLI

Crosstalk can hand a task from a Claude Code session to GitHub Copilot CLI. Copilot works in its own git worktree and branch, asks you before it writes, runs a command or uses the network, and the result comes back to the session that asked as a Crosstalk message.

This is **Phase 2**: it works from the command line and the transcript, with a live terminal view (`/crosstalk-gh open`) and a meter above the prompt. A chat of its own in the desktop app's sidebar and a pane come in later phases.

## What you need

- A git repository with at least one commit.
- Node.js 22.18 or newer (`node --version`).
- Copilot signed in with your personal GitHub account: run `copilot login` yourself, in a terminal. Crosstalk never sees or stores a token.
- Then, once: `/crosstalk-gh setup`. It installs the official Copilot SDK (`@github/copilot-sdk`, a pinned version, with npm install scripts off) into `~/.claude-crosstalk/copilot/runtime`, and checks who Copilot is signed in as. Nothing goes into your project or the plugin. You can type it, or ask Claude to run it through the `crosstalk_gh` tool.

## Two ways Copilot is driven

- **The SDK (the default once `/crosstalk-gh setup` has run).** The SDK checks every tool call before it runs. When you refuse a request it ends Copilot's turn, and the reply says so; a follow-up can tell Copilot another way to go.
- **Copilot CLI over ACP** (without setup, or with `"backend": "acp"`). This needs Copilot CLI 1.0.105 or newer on your PATH. Earlier versions could run tools without asking, so Crosstalk refuses them. A refused request is passed to Copilot, which carries on without it.

Either way, the safety self-test and the stop-for-safety check below apply.

## Use it

```
/crosstalk-gh Add a retry to the upload client and a test for it
```

Crosstalk records where the session is (folder, repository, branch, commit, the files this session edited), makes a worktree at `<repo>-copilot/<task>` on branch `copilot/<task>`, and starts Copilot there. Your uncommitted changes are not in the worktree: it is cut from the last commit, and Crosstalk says so when you have any.

| Command | What it does |
|---|---|
| `/crosstalk-gh <task>` | Hands the task over |
| `/crosstalk-gh status` | This session's tasks, what each has used, and any request waiting for you |
| `/crosstalk-gh approve <request>` | Allows that one request |
| `/crosstalk-gh allow <request>` | Allows it, and the same kind for the rest of the task (see below) |
| `/crosstalk-gh deny <request>` | Refuses it |
| `/crosstalk-gh open [task]` | Opens a terminal that shows the task live and answers its requests (see below) |
| `/crosstalk-gh stop [task]` | Stops a task; its branch and worktree are kept |
| `/crosstalk-gh setup` | Installs the Copilot SDK and checks the sign-in (run it again to repair) |

Sending a follow-up is an ordinary Crosstalk message to the task (`/crosstalk to copilot/<task> ...`, or ask Claude to send it). Only the session that started a task can add to it, and the task stays up for ten minutes after each turn to hear one.

## Watch it live

`/crosstalk-gh open` opens a terminal on the task: what Copilot says and thinks, its plan, each tool it runs with the exact command, and a diff of every file it changes. With no task named it opens the running one, or the newest when none runs; a task that has ended is replayed.

In the Claude desktop app it is a new tab of the app's Terminal panel (the app asks you to approve the command first); elsewhere, or with `/crosstalk where window`, a terminal window: Windows Terminal, Terminal.app, or the first Linux terminal found. If neither works, the answer gives the command to run yourself:

```
node <plugin folder>/copilot/tui/attach.ts <task> --root ~/.claude-crosstalk
```

| Key | What it does |
|---|---|
| `y` | Approves the request shown |
| `a` | Allows it for the rest of the task (when the request offers it) |
| `n` | Denies it |
| `s`, then `y` | Stops the task |
| `q` or Ctrl+C | Closes the view; the task keeps running |

A request answered here counts as yours, like a typed command or the pop-up; whichever answers first wins. The view closes by itself when the task ends. Everything Copilot wrote is stripped of terminal control characters before it is shown, so its output can't move the cursor or rename the window.

## Requests

When Copilot wants to do something, a request shows in the transcript with exactly what would run or be touched, and a notice appears. Nothing happens until you answer, and a request nobody answers within ten minutes is denied.

| Copilot wants to | Risk shown | `/crosstalk-gh allow` covers |
|---|---|---|
| Write inside its worktree | low | every write inside the worktree, for this task |
| Run a shell command | high | commands starting with the same two words (`npm test`), and never a line that chains commands |
| Use the network | high | that exact host |
| Touch anything outside its worktree | high | nothing: each one is asked |

You answer, or Claude does when you ask it to: `/crosstalk-gh approve` works when you type it, and through the `crosstalk_gh` tool in this session. A message from another session or from Copilot itself can never answer a request.

**If Copilot ever runs a tool without asking**, Crosstalk ends it on the spot and the reply says `STOPPED FOR SAFETY`, with the command that ran. Check the worktree before using anything from it. In `bypass` mode it's only logged, and the task carries on.

## The reply

When a turn ends, the session that asked gets a message with what Copilot reported (its own words, not checked), a diff stat, the branch, and three commands: review, merge, discard. Whatever Copilot left uncommitted is committed on the task's branch first, so the branch holds the whole task.

## Limits on a task

- 5 prompts and 100 AI credits (about one US dollar) per task. GitHub bills Copilot in AI credits, by tokens; the estimate uses GitHub's published rates and is shown for the models it knows (Claude Sonnet 5.5, Claude Opus 5.5). For other models the prompt limit still holds.
- 25 follow-ups in a row, the same limit as Crosstalk's wake-ups.
- 30 minutes per turn.

## Settings

`~/.claude-crosstalk/copilot/config.json`, all optional:

```json
{
  "model": "claude-sonnet-5.5",
  "worktreeRoot": "C:/wt/my-repo-copilot",
  "permissionTimeoutMs": 600000,
  "turnTimeoutMs": 1800000,
  "idleMs": 600000,
  "backend": "auto",
  "account": "your-github-login"
}
```

On Windows, a short `worktreeRoot` keeps paths under the length limit.

`backend` is `auto` (the SDK when it is installed, otherwise ACP), `sdk` or `acp`. `account` pins the GitHub login Copilot must be signed in as on the SDK. A task signed in as anyone else is refused, which keeps a work account's Copilot off personal tasks.

## Where things are kept

Under `~/.claude-crosstalk/copilot/`:

- `tasks/<task>/task.json` is the handoff, `state.json` where the task stands, `events/` what Copilot did, `sidecar.log` the sidecar's own log.
- `audit/<date>.jsonl` records every task, every request with exactly what was asked, and every decision with who made it.
- `selftest.json` records which Copilot versions passed the safety self-test. Each new version is asked once to write a file in a throwaway folder and refused; one that writes anyway is given no tasks. This costs one small prompt per Copilot version.

## Manual test (Phase 1)

Run these in a real session, in a repository you don't mind a test branch in. Each step says what you should see.

1. `/crosstalk-gh setup` in a Claude session says `Installed @github/copilot-sdk@...` and `Copilot ... is signed in as <your login>`. (To test ACP instead, set `"backend": "acp"` and check that `copilot --version` shows 1.0.105 or newer.)
2. In a Claude session in that repository: `/crosstalk-gh Add a file called HELLO.md that says hello`. You see `Copilot task add-a-file-... started, on branch copilot/...`.
3. Within a minute a request appears: `Copilot task ... asks to write to inside its worktree (low risk)` with the path, and a notice. `/crosstalk-gh status` shows the task `awaiting approval`.
4. `/crosstalk-gh approve r1`. You see `Approved: r1 of ...`.
5. A Crosstalk message arrives: `Copilot task ... finished`, with a diff stat naming `HELLO.md`, the branch, and the three commands.
6. `git status` in your own checkout is unchanged. Run the review command from the reply: it shows the new file.
7. Start another task that needs a command, such as `/crosstalk-gh Run the tests and tell me what fails`. The request shows the exact command and `high risk`. `/crosstalk-gh deny r1`. On the SDK the reply says Copilot stopped when its request was refused; on ACP it says Copilot was not allowed.
8. Start a third task and leave its request unanswered, then `/crosstalk-gh stop`. The reply says it was stopped.
9. Clean up with the discard command from each reply.

What step 2 does on the first task only: the safety self-test runs first, so the first task takes a little longer and uses one extra small prompt.

## Manual test (Phase 2)

On Windows, and on macOS when you have one:

1. `/crosstalk-gh Run the tests and tell me what fails`, then `/crosstalk-gh open`. In the desktop app, approve the command the app shows; a Terminal-panel tab opens. In a plain terminal session a new terminal window opens instead.
2. The view shows `Copilot task ...`, the branch and the task, then Copilot's words as they come.
3. When Copilot wants to run the tests, a yellow card shows the exact command and `high risk`, with `y approve   n deny`. Press `y`. The view says `Approved: r1.`, the pop-up in the Claude session goes stale (picking in it does nothing), and the tool line turns from `…` to `▶` to `✓`.
4. For a task that writes a file, the view shows the file's diff once the write is done.
5. Press `q`: the view closes and the task carries on. `/crosstalk-gh open` again replays it from the start.
6. Press `s`, then `y`: the task stops, and the reply in the Claude session says it was stopped. The view closes by itself.

## Not built yet

- No chat of its own in the desktop app's sidebar (Phase 3), no Copilot pane or permission cards (Phase 4).
- Messages are not signed (Phase 5). Until then, treat `~/.claude-crosstalk` as you treat any folder only you can write to.
