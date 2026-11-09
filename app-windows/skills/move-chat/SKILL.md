---
name: move-chat
description: Move the current conversation to another Claude account's window (fuuk, mikey, or back to default/main) so the work carries on there on that account's usage. Compacts this chat into a handoff, opens a session on that account pointed at it, presses Send, and checks it picked up. Use when the user says "move this to fuuk", "carry on on fuuk", "resume on <account>", "hand this chat over", or a usage limit is close.
argument-hint: "<profile: fuuk | mikey | default>  [what the next session should focus on]"
---

Moves this chat to another account. Keep every step short: the point is to save tokens.

## 1. Write the handoff

Follow the `handoff` skill's rules for content (3-line TL;DR first, half-finished and unverified items listed, reference files/commits by path instead of copying them, redact secrets, a "Suggested skills" section), with these changes:

- Save to `~/claude-shared/handoffs/YYYY-MM-DD-HHMM-<what-was-done>.md` (every profile can read it). Project rules that say where handoffs go still win.
- Keep it under ~120 lines. Include: the goal in the user's words, decisions made (and who made them), what is done and verified, what is left in order, exact paths, commands that worked, gotchas found, and the user's working preferences that came up in this chat.
- Add a "Where this came from" section: this session's crosstalk address (run crosstalk `list` right before writing; the first line says "You are …", and names change when a session is renamed), the folder, and the full transcript path: `<config dir>\projects\<folder slug>\<session id>.jsonl` (main account `~\.claude`, others `~\.claude-<profile>`; find it with `ls -t <config dir>/projects/*/*.jsonl | head`). Mark it "grep for a detail, never read whole".
- Commit finished, verified work first if the project commits as it goes.

## 2. Open the session on the other account

Pick the folder: the project's main checkout (not a worktree of this session, unless the work lives only on that worktree's branch: then name the branch in the handoff and use the main checkout).

Run in PowerShell (one line):

```
& "$env:USERPROFILE\claude-shared\claude-new-session.ps1" <profile> "<folder>" "Resume from a handoff: read <full handoff path> first, then carry on with its next steps. Message <this session's crosstalk address> over crosstalk only if you're blocked or when done." -Send
```

- `<profile>` is `fuuk`, `mikey`, or `default` (the main window).
- Never start the prompt with `/` (the app neutralises it; the script rewrites it to "Use the … skill").
- The script presses "Trust workspace" for that folder if asked, then Send. If it prints "Gave up", run crosstalk `list` anyway (it may have sent) before retrying, and never send twice.
- The other account's window must be open (`claude-app.ps1 <profile>`); if no window is found, start it and run the line again.
- No app window wanted, or it keeps failing: use the crosstalk `open` tool instead (`profile`, `message` = the same resume prompt). That starts a terminal-tab session on that profile, already trusted.

## 3. Check it picked up

Run crosstalk `list` once: the new session shows as `<profile>/<title>-xxxx`. Don't poll. Its message arrives here on its own if it is blocked or done.

## 4. Tell the user (3 lines)

- The handoff path, and the new session's crosstalk name.
- That this chat can be left or archived now; to come back, say "move this to default" (or the account) in the other chat.
- Anything not carried over or not verified.
