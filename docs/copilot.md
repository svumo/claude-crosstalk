# Handing tasks to GitHub Copilot CLI

Crosstalk can hand a task from a Claude Code session to GitHub Copilot CLI. Copilot works in its own git worktree and branch, asks you before it writes, runs a command or uses the network, and the result comes back to the session that asked as a Crosstalk message.

This is **Phase 1**: it works from the command line and the transcript. A live terminal view, a chat of its own in the desktop app's sidebar, a pane and a status line come in later phases.

## What you need

- A git repository with at least one commit.
- Node.js 22.18 or newer (`node --version`).
- GitHub Copilot CLI 1.0.105 or newer, signed in with your personal GitHub account: run `copilot login` yourself, in a terminal. Crosstalk never sees or stores a token. Versions before 1.0.105 could run tools without asking, so Crosstalk refuses them.

## Use it

```
/copilot Add a retry to the upload client and a test for it
```

Crosstalk records where the session is (folder, repository, branch, commit, the files this session edited), makes a worktree at `<repo>-copilot/<task>` on branch `copilot/<task>`, and starts Copilot there. Your uncommitted changes are not in the worktree: it is cut from the last commit, and Crosstalk says so when you have any.

| Command | What it does |
|---|---|
| `/copilot <task>` | Hands the task over |
| `/copilot status` | This session's tasks, what each has used, and any request waiting for you |
| `/copilot approve <request>` | Allows that one request |
| `/copilot allow <request>` | Allows it, and the same kind for the rest of the task (see below) |
| `/copilot deny <request>` | Refuses it |
| `/copilot stop [task]` | Stops a task; its branch and worktree are kept |

Sending a follow-up is an ordinary Crosstalk message to the task (`/crosstalk to copilot/<task> ...`, or ask Claude to send it). Only the session that started a task can add to it, and the task stays up for ten minutes after each turn to hear one.

## Requests

When Copilot wants to do something, a request shows in the transcript with exactly what would run or be touched, and a notice appears. Nothing happens until you answer, and a request nobody answers within ten minutes is denied.

| Copilot wants to | Risk shown | `/copilot allow` covers |
|---|---|---|
| Write inside its worktree | low | every write inside the worktree, for this task |
| Run a shell command | high | commands starting with the same two words (`npm test`), and never a line that chains commands |
| Use the network | high | that exact host |
| Touch anything outside its worktree | high | nothing: each one is asked |

Only you can answer. `/copilot approve` works when you type it; Claude cannot run it for you, and no tool the model can call writes an answer.

**If Copilot ever runs a tool without asking**, Crosstalk ends it on the spot and the reply says `STOPPED FOR SAFETY`. Check the worktree before using anything from it.

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
  "idleMs": 600000
}
```

On Windows, a short `worktreeRoot` keeps paths under the length limit.

## Where things are kept

Under `~/.claude-crosstalk/copilot/`:

- `tasks/<task>/task.json` is the handoff, `state.json` where the task stands, `events/` what Copilot did, `sidecar.log` the sidecar's own log.
- `audit/<date>.jsonl` records every task, every request with exactly what was asked, and every decision with who made it.
- `selftest.json` records which Copilot versions passed the safety self-test. Each new version is asked once to write a file in a throwaway folder and refused; one that writes anyway is given no tasks. This costs one small prompt per Copilot version.

## Manual test (Phase 1)

Run these in a real session, in a repository you don't mind a test branch in. Each step says what you should see.

1. `copilot --version` in a terminal shows 1.0.105 or newer, and `copilot` starts signed in.
2. In a Claude session in that repository: `/copilot Add a file called HELLO.md that says hello`. You see `Copilot task add-a-file-... started, on branch copilot/...`.
3. Within a minute a request appears: `Copilot task ... asks to write to inside its worktree (low risk)` with the path, and a notice. `/copilot status` shows the task `awaiting approval`.
4. `/copilot approve r1`. You see `Approved: r1 of ...`.
5. A Crosstalk message arrives: `Copilot task ... finished`, with a diff stat naming `HELLO.md`, the branch, and the three commands.
6. `git status` in your own checkout is unchanged. Run the review command from the reply: it shows the new file.
7. Start another task that needs a command, such as `/copilot Run the tests and tell me what fails`. The request shows the exact command and `high risk`. `/copilot deny r1`. The reply says Copilot was not allowed.
8. Start a third task and leave its request unanswered, then `/copilot stop`. The reply says it was stopped.
9. Clean up with the discard command from each reply.

What step 2 does on the first task only: the safety self-test runs first, so the first task takes a little longer and uses one extra small prompt.

## Not in Phase 1

- Copilot's work is not shown live; `/copilot status` and the reply are the view. (Phase 2: a terminal view you can also answer from.)
- No chat of its own in the desktop app's sidebar (Phase 3), no pane or status line (Phase 4).
- Messages are not signed (Phase 5). Until then, treat `~/.claude-crosstalk` as you treat any folder only you can write to.
- The Copilot SDK backend is not built yet; tasks run over Copilot CLI's ACP server, guarded by the version floor, the self-test and the stop-for-safety check.
