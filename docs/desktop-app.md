# Using Crosstalk with the Claude desktop app

Crosstalk works in the desktop app's Code tab the same way it works in a terminal: sessions can list each other and send messages. The one difference is **accounts**. The app signs in to one Claude account at a time, and every session you start in it runs on that account. To add sessions on your other accounts (a second subscription, a work login, another provider), pick one of two setups.

| | A. Terminal-panel tab | B. A second app window |
|---|---|---|
| What you get | The other account's session as a **CLI inside the app's Terminal panel** | The other account in **its own app window**, with the full Code tab, sidebar and history |
| Setup | None beyond normal Crosstalk setup | One-time: run an installer, sign in to the new window |
| Works on | Windows (macOS should work too, but isn't tested yet) | Windows only |
| Good for | Quick side jobs: reviews, second opinions, using another account's usage | Long work on another account that you want to see and steer in the app |

You can use both. Messages go between all of them, and between them and any terminal or VS Code sessions.

## First: normal Crosstalk setup

Do this whichever option you pick.

1. Install the plugin and run `/crosstalk setup`, then `/crosstalk setup yes`, so every profile (`~/.claude`, `~/.claude-<name>`) has it. See [Multiple Claude accounts](../README.md#multiple-claude-accounts).
2. Sign in to each profile once from a terminal (`claude-<name>`, or however you start it), so each has its own login.
3. Restart any session that was already open. Sessions load the plugin only when they start.

## A. Terminal-panel tab (no extra setup)

In a desktop-app session, say:

```
/crosstalk open work
```

or just ask: "open a session on my work account and ask it to review this branch."

Crosstalk types the profile's launch command into a **new tab of the app's Terminal panel**, in the same folder. The app shows you the command and asks you to approve it. Once the session is up, Crosstalk says so and sends it your first message.

What has to be true:
- **The launch command works in your shell.** The panel runs your normal PowerShell (or login shell on macOS) with your profile loaded. The default command is `claude-<profile>`. If you start profiles another way, tell Crosstalk once: `/crosstalk launch work claude work`.
- **The command is a plain one-liner.** The app's Terminal tool won't type variables, pipes or `$( )`. Wrap anything fancier in a function in your shell profile and launch that.

**Which account.** A profile you name always wins. With none (`/crosstalk open`, or "open a different session"), it opens this session's own profile, the account you're working in. A Terminal-panel tab can run one account inside another account's window, such as a `mikey` session in a tab of the `fuuk` window. Crosstalk finds the window from the session's parent processes, so `list` says "in the fuuk app window". `/crosstalk open window` opens that window's account. If Crosstalk can't tell the window, it says so and doesn't guess. Set `CLAUDE_CROSSTALK_WINDOW` to override it.

To see what `open` will do from a session, run `/crosstalk open-in`. To go back to separate terminal windows, use `/crosstalk open-in window`.

## B. A second app window per account (Windows)

This runs a second copy of the desktop app with its own data folder, so it stays signed in to another account next to your main window. Its Code-tab sessions use that profile's Claude Code folder (`~\.claude-<profile>`), so they get its plugins, settings and Crosstalk.

### What you need

- Windows 10 or 11 with the Claude desktop app, from the Microsoft Store or the standard installer.
- PowerShell 7 (`pwsh`) or Windows PowerShell 5.1.
- The profile already set up for Claude Code, with Crosstalk installed (see the setup steps above).
- An English-language app UI, for the auto-Send part only (it finds the Send button by its name).

### Install

From the plugin's folder (`/crosstalk setup` shows where it is), in PowerShell:

```powershell
& .\app-windows\install.ps1 -Shortcuts work
```

This:
- copies the scripts to `~\.claude-crosstalk\app-windows\` (Crosstalk's shared folder, or `CLAUDE_CROSSTALK_DIR` if you set one);
- copies the `move-chat` skill into every profile;
- makes a Start-menu shortcut called **Claude (work)**. Pass several names to make several shortcuts: `-Shortcuts work,personal`.

Add `-WhatIf` to see what it would do without changing anything. Run it again after a Crosstalk update to pick up new versions of the scripts.

If PowerShell refuses to run the installer, allow it for this one run: `pwsh -ExecutionPolicy Bypass -File .\app-windows\install.ps1 -Shortcuts work`.

### Open the window and sign in

Open **Claude (work)** from the Start menu, or run:

```powershell
& "$env:USERPROFILE\.claude-crosstalk\app-windows\claude-app.ps1" work
```

A new Claude window opens, signed out. Sign in with **the email code**: type your email, then type the code from the email into this window.

Don't click "Open Claude" in the browser. Windows always sends `claude://` links to your main window, so that sign-in would land in the wrong place. Windows handles app links this way, and it can't safely be changed.

After sign-in the window may close to the tray. Open the shortcut again to bring it back.

### Start sessions in it from anywhere

From any session (or your own PowerShell):

```powershell
& "$env:USERPROFILE\.claude-crosstalk\app-windows\claude-new-session.ps1" work "C:\code\my-app" "Review the open PR and list problems" -Send
```

This opens a new Code session in the `work` window, in that folder, with the prompt typed in. `-Send` presses Send for you through Windows UI Automation. It doesn't use the mouse or keyboard and doesn't take screenshots. If the app asks "Trust this workspace?" for exactly that folder, the script answers it. A dialog for any other folder is left for you. Use `default` instead of `work` for your main window. Use `here` for the window you're working in: the app window the calling session runs in (a Terminal-panel tab counts as its window's), or, outside the app, the window of that session's own profile. Add `-DryRun` to see which window it would use, and why, without opening anything.

Prompts can't start with `/`, because the app disables a leading slash that comes by link. The script rewrites `/skill args` as "Use the skill skill: args", which has the same effect.

### Move a chat to another account

In any session, say "move this to work" (or `default` to come back). Say "use a different session" with no account, and it opens in the window you're in (`here`). The `move-chat` skill writes a handoff file to `~\.claude-crosstalk\handoffs\`, opens a session on that account pointed at it, presses Send, and checks with Crosstalk that it started. It's handy when one account is near its usage limit.

### How the pieces fit

- `claude-app.ps1 <profile>` starts the app with `--user-data-dir=~\.claude-<profile>-app` and `CLAUDE_CONFIG_DIR=~\.claude-<profile>`. The data folder holds the window's sign-in and sidebar. The config folder holds Claude Code's settings, plugins and transcripts for that account. Your own shell's `CLAUDE_CONFIG_DIR` is left as it was.
- Crosstalk reads each window's session titles from its data folder, so `list` shows sessions in the second window by their sidebar names. If you used a different folder, set `CLAUDE_CROSSTALK_APP_DATA`.
- Each window keeps its own record of trusted folders. Expect a "Trust this workspace?" prompt the first time each folder opens in each window.

| Script | What it does |
|---|---|
| `claude-app.ps1 <profile> [claude://link]` | Starts that profile's window, or brings it up, and can pass it a `claude://` link |
| `claude-new-session.ps1 <profile or here> "<folder>" "<prompt>" [-Send] [-DryRun]` | Opens a new Code session in that window with the folder and prompt filled in |
| `claude-press-send.ps1 <profile> [-Expect text] [-Folder path]` | Presses Send in that window, and answers the trust prompt for `-Folder` only |
| `install.ps1 [-Shortcuts names] [-WhatIf]` | Installs the scripts and the skill, and makes shortcuts |

## Limits

- **One account per window.** A window can't show another account's chats, and the main window never lists sessions from the second window. Crosstalk's `list` is the one place that sees all of them.
- **Links always open the main window.** Windows sends every `claude://` link to the main app. The scripts get around this by starting the right window directly, but sign-in links and links clicked in a browser still go to the main window.
- **Windows only for option B.**
- **App updates can move things.** Option B uses the app's own `claude://code/new` link and the names of its buttons. A big app update could change either one. If `-Send` reports "Gave up", run `list` first, because it may have sent anyway. Never send twice.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Claude desktop app not found" | The scripts look for the Microsoft Store copy and `%LOCALAPPDATA%\AnthropicClaude\claude.exe`. Install the app, or tell us where yours is. |
| The second window opens signed in as your main account | It's using the main data folder. Start it only with the shortcut or `claude-app.ps1`, which pass `--user-data-dir`. |
| A session in the second window isn't in `/crosstalk` | Crosstalk isn't installed in `~\.claude-<profile>`. Run `/crosstalk setup yes`, then start a new session. |
| It's listed by address, not by name | It has no title yet (it gets one after the first message). If it never does, set `CLAUDE_CROSSTALK_APP_DATA` to that window's data folder. |
| `-Send` says "No Claude window running for profile" | Open the window first with the shortcut or `claude-app.ps1 <profile>`. |
| Option A says the Terminal panel didn't run it | You declined the command, or the launch command doesn't work in your shell. Test `claude-<profile>` in the panel yourself, or set it with `/crosstalk launch`. |
