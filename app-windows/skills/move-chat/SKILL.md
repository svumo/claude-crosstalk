---
name: move-chat
description: Move the current conversation to another Claude account's desktop app window (any Crosstalk profile, or default for the main window) so the work carries on there on that account's usage. Writes a handoff, opens a session on that account pointed at it, presses Send, and checks it started. Use when the user says "move this to <account>", "carry on on <account>", "resume on <account>", "hand this chat over", or a usage limit is close.
argument-hint: "<profile, or default>  [what the next session should focus on]"
---

Moves this chat to another account. Keep every step short: the point is to save tokens.

The scripts live in Crosstalk's shared folder: `$env:CLAUDE_CROSSTALK_DIR\app-windows`, or `~\.claude-crosstalk\app-windows` when that variable isn't set. Below, `<xt>` means that shared folder.

## 1. Write the handoff

Save it to `<xt>\handoffs\YYYY-MM-DD-HHMM-<what-was-done>.md`, where every profile can read it. A project rule that says where handoffs go wins.

Keep it under about 120 lines:

- **TL;DR**: 2 to 3 lines, first.
- **Goal**, in the user's own words.
- **Decisions** made, and who made them.
- **Done and verified**, and separately anything half-finished or not verified.
- **Left, in order.**
- **Exact paths**, the commands that worked, and the gotchas found.
- **The user's working preferences** that came up in this chat.
- **Where this came from**:
  - This session's Crosstalk address. Run crosstalk `list` right before writing: its first line says "You are …".
  - The folder.
  - The full transcript path: `<config dir>\projects\<folder slug>\<session id>.jsonl`. The config dir is `~\.claude` for the main account and `~\.claude-<profile>` for others. Find it with `ls -t <config dir>/projects/*/*.jsonl | head`. Mark it "grep for a detail, never read whole".
- **Suggested skills** for the next session.

Point to files and commits by path instead of copying them in. Leave secrets out. If the project commits as it goes, commit finished, verified work first.

## 2. Open the session on the other account

Pick the folder: the project's main checkout, so the app files the session under the same project in its sidebar. Use a worktree of this session only if the work lives only on that worktree's branch. In that case, name the branch in the handoff and still use the main checkout.

Pick the last sentence of the prompt (`<report line>` below):

- **This session is near its limit**: crosstalk `list`'s first line says "over its stop point", the user says a usage limit is close, or the guard stopped this chat. Use: `You own this work alone: don't message <this session's crosstalk address>, as it is paused near its usage limit; if you're blocked, ask the user in your own chat.` A report back would land on a session that can't answer, or spend what usage it has left.
- **Otherwise** (plenty of usage left): `Message <this session's crosstalk address> over crosstalk only if you're blocked or when done.`

Run this in PowerShell, as one line:

```
& "<xt>\app-windows\claude-new-session.ps1" <profile> "<folder>" "Resume from a handoff: read <full handoff path> first, then carry on with its next steps. <report line>" -Send
```

- `<profile>` is the Crosstalk profile name, or `default` for the main window.
- Never start the prompt with `/`. The app disables a leading slash that comes by link, so the script rewrites it as "Use the … skill".
- The script presses "Trust workspace" for that folder if the app asks, then presses Send. If it prints "Gave up", run crosstalk `list` first, because it may have sent anyway. Never send twice.
- If it says no window is running, start one with `& "<xt>\app-windows\claude-app.ps1" <profile>` and run the line again.
- If you don't need the app window, or it keeps failing, use the crosstalk `open` tool instead, with `profile` and `message` set to the same resume prompt. From the desktop app, that starts the profile in a tab of the app's Terminal panel. It isn't listed in that account's app sidebar.

## 3. Check it started

Run crosstalk `list` once. The new session shows up by its title, with an address like `<profile>/<title>-xxxx`. Don't poll: its message arrives here by itself if it gets blocked or finishes, unless it was told to work alone.

## 4. Tell the user (3 lines)

- The handoff path, and the new session's name in Crosstalk.
- That this chat can be left or archived now. To come back, say "move this to default" (or this account's profile) in the other chat.
- Anything not carried over or not verified.
