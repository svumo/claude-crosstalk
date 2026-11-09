# A Claude desktop window per account (Windows)

The Claude desktop app signs in to one account. These scripts run a second copy of the app for another account, start sessions in it from any other session, and move a whole chat from one account to another. Crosstalk carries the messages between them.

Windows only. Tested with Claude desktop 4.23 on Windows 11.

## Install

Copy the three scripts to `~\claude-shared\` (the skill expects them there) and the skill to each profile's skills folder:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\claude-shared" | Out-Null
Copy-Item app-windows\*.ps1 "$env:USERPROFILE\claude-shared\"
Copy-Item -Recurse app-windows\skills\move-chat "$env:USERPROFILE\.claude\skills\"
```

## The scripts

| Script | What it does |
|---|---|
| `claude-app.ps1 <profile> [claude://link]` | Starts (or brings up) the app for that profile, with its own data folder `~\.claude-<profile>-app`, and Claude Code sessions in it using `~\.claude-<profile>`. Sign in by typing the emailed code: the browser's "Open Claude" link always goes to the main window. |
| `claude-new-session.ps1 <profile> "<folder>" "<prompt>" [-Send]` | Opens a new Code session in that profile's window, in that folder, with the prompt typed in. `default` (or `main`) means the main window. `-Send` also presses Send. |
| `claude-press-send.ps1 <profile> [-Expect text] [-Folder path]` | Presses Send in that profile's window through Windows UI Automation (no screenshots, no mouse, no key presses). |

What `claude-press-send.ps1` handles:

- **The right window.** It picks the `claude.exe` whose `--user-data-dir` is `.claude-<profile>-app`. For `default`, it picks the one without that flag.
- **The trust prompt.** It presses "Trust workspace" only when the dialog shows exactly `-Folder`. Any other folder is left for you.
- **An old draft.** A link never overwrites text already in a folder's new-session box. When the box holds something other than `-Expect`, the script puts the expected prompt in through UI Automation, once.
- **A leading slash.** The app turns a `/` at the start of a prompt that arrived by link into a full-width `／`, so the skill wouldn't run. `claude-new-session.ps1` rewrites `/skill args` as "Use the skill skill: args".

## Moving a chat to another account

Say "move this to fuuk" (or any profile, or `default`) in a session that has the `move-chat` skill. The skill:

1. **Handoff.** Writes one to `~\claude-shared\handoffs\`, with the sender's crosstalk address and the path of the full transcript, for looking up details.
2. **New session.** Opens a session on that account in the project's main folder, so the app files it under the same project in the sidebar, and sends "Resume from a handoff: read …".
3. **Check.** Runs crosstalk `list` once to confirm the new session is there.

If you don't need the app window, `/crosstalk open <profile>` is cheaper: a terminal-tab session, already trusted, with the first message sent. It doesn't show in that account's app sidebar.

## Known limits

- **Repository trust.** The app keeps a per-repository trust record of its own, besides `.claude.json`, so a repository can ask once per window. `-Folder` answers it.
- **Accessibility tree.** Chromium switches on its accessibility tree after the first UI Automation query, so the scripts query again until the controls appear.
- **One account per window.** A window can't show more than one account's chats.
