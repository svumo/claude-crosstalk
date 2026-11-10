# Changelog

## Unreleased

**Hand a task to GitHub Copilot CLI (Phase 1 of 5: from the command line)**
- **The command is `/crosstalk-gh`** (it was `/copilot`).
- **Claude can drive Crosstalk**: two new tools run the same command lines you type. `crosstalk` runs any `/crosstalk` command and `crosstalk_gh` runs any `/crosstalk-gh` command, including approve, allow, deny, mode, model and setup. Those last ones used to need your own Enter; you asked for Claude to run them too.
- `crosstalk_gh` takes `images`, paths of up to 10 pictures, with a task. They go into Copilot's worktree like pictures pasted with `/crosstalk-gh`, and the task starts at once.
- `/crosstalk-gh <task>` hands a task to GitHub Copilot CLI. Copilot works in its own git worktree (`<repo>-copilot/<task>`) on its own branch, cut from the commit your session is on, and the result comes back as a Crosstalk message with what Copilot reported, a diff stat, the branch, and the commands to review, merge or discard it. Your own checkout is not touched.
- Copilot asks before it writes, runs a command or uses the network. Each request shows exactly what would run or be touched; `/crosstalk-gh approve`, `/crosstalk-gh allow` (for the rest of the task) and `/crosstalk-gh deny` answer it, and only when you type them. A request nobody answers is denied. Shell commands, the network and anything outside the worktree are always marked high risk.
- **Requests pop up** in Claude Code's own question dialog (Approve, Allow for task, Deny, Bypass this task) instead of lines in the transcript; one at a time, and one already answered never shows. The typed commands still work.
- **Permission modes**: `ask` (every request comes to you), `auto` (reads and writes inside the task's worktree go through; commands, network and anything outside still ask) and `bypass` (everything goes through). `/crosstalk-gh --bypass <task>` (or `--auto`, `--mode <mode>`) starts one task in a mode; `/crosstalk-gh mode` opens a picker, and `/crosstalk-gh mode bypass [task]` sets the default and switches this session's running tasks, including a request already waiting. Only you can change the mode. A bypass task shows a red `bypass` on the Copilot row, and every mode change is in the audit log.
- **Models**: `/crosstalk-gh models` lists the models Copilot offers your account (on the SDK backend); `/crosstalk-gh model <id>` picks the one new tasks use, and `/crosstalk-gh --model <id> <task>` picks it for one task.
- If Copilot runs a tool without asking, Crosstalk ends it at once and says so, naming the command. Copilot CLI before 1.0.105 could do that, so it is refused, and each new version must pass a small self-test before it gets a task. In `bypass` such a tool is logged (`ran without asking (bypass): <command>`) and the task goes on, since everything was approved anyway; Copilot 1.0.108 runs some shell commands it judges safe (such as `git status`) without asking.
- **Fewer notifications**: a turn that a Crosstalk message started no longer raises a "finished" notification unless it brings a Copilot run's result. Your own turns finishing, and questions or approvals waiting on you, still notify.
- `/crosstalk-gh status` shows this session's tasks and what each has used; `/crosstalk-gh stop` ends one. A task is limited to 5 prompts and 100 AI credits.
- **A Copilot meter above the prompt**, among the skins usage meters: a purple ring like skins' context / 5h / 7d rings for the account's monthly AI credits as GitHub reports it (`11% gh · reset 1 Dec`), after 7d. In the terminal, where rings can't draw, it is a block bar (`█░░░░░░░ 11% copilot`), and skins' bars on that row are redrawn in the same blocks, since many console fonts have no `▰▱`. Then this session's task with a dot that is green while Copilot works, orange while it waits for your answer, and grey between turns. The meter is read with `gh api copilot_internal/user` (the endpoint Copilot's editor extensions read; GitHub doesn't document it) every minute while a task runs and every ten otherwise. `/crosstalk-gh status` adds the meter in words, and each result says how far the meter moved while the task ran (the whole account's use, and it can lag a few minutes).
- **Pasted pictures go with the task**: a screenshot pasted with `/crosstalk-gh <task>` is saved into the task's worktree (`.copilot-pictures/`, which git ignores, so it stays off the branch), and Copilot is told to open it first. Up to 10 pictures, 20 MB together. The task starts a moment after the command (at most 2.5 s), once the pictures are read.
- A task is a Crosstalk peer (`copilot/<task>`): the session that started it can send it a follow-up.
- `/crosstalk-gh setup` installs the official Copilot SDK (pinned, install scripts off) into Crosstalk's own folder, and tasks then run on it: it checks every tool call before it runs. Without it, tasks run on Copilot CLI over ACP. `"account"` in the settings pins the GitHub login Copilot must be signed in as.
- Needs Node.js 22.18 or newer and Copilot signed in by you (`copilot login`). Crosstalk handles no tokens. See [docs/copilot.md](docs/copilot.md).
- Messages have a version 1 format that today's sessions still read as before.
- **Fix:** when Crosstalk reloaded mid-turn (an update installed into a running session), a message the session had already had could reach the model again. The session went live before it read which messages it had had; it now reads that first.
- **Fix:** clicking a notification switched the window to its session but left the window behind whatever you were in, as Windows won't let the app bring itself forward from a background launch. ToastHost, the program you clicked, now brings the window forward first. It logs each click's outcome to `toast-host.log`.
- **Fix:** notifications lost the Claude logo when the app updated, since their shortcuts pointed into the old version's folder. The logo is now kept in Crosstalk's own folder (`app-windows\claude-logo.png` and `.ico`), copied again whenever the app updates, and shown beside the notification's text as well.

## 1.8.2

- **Notification clicks work.** Windows would not run a custom link when a notification was clicked ("Get an app to open this link"), and removes a notification when the program that raised it ends. So the notification is now raised by `ToastHost.exe`, a small program `install.ps1` builds with the C# compiler that comes with Windows. It stays hidden for 15 minutes, hears the click itself, and opens that window on that session. No link or default-app entry is registered any more, and `install.ps1` removes the ones an earlier build made.
- The click handler (`claude-open-link.ps1`) only opens a window that already exists, so it can't start a new signed-out one, and logs each click to `open-link.log` in Crosstalk's folder.

## 1.8.1

- A session the app started ahead of time (a "spare") runs in a temporary folder that the app deletes once the session is in use. `open` now opens in the project folder from the session's app record instead, so it no longer fails with "No such folder: ...\spares\spare-...". If the project folder can't be found it says so.
- Each window's notification name ("Claude (mikey)") is set up front, on the Start-menu shortcut of that name.

## 1.8.0

**`open` goes where you are, and never somewhere else**
- From a Claude desktop app session on Windows, `open fuuk` starts a Code session in **fuuk's own app window** (`default` is the main window), with the folder and your first message filled in and sent. Before, it typed a command into a Terminal-panel tab of the window you were in. Use `--in panel` for the old behaviour. A profile with no app window yet is told plainly, with how to make one.
- From a VS Code or VSCodium terminal, it opens a tab in that editor. If the Crosstalk terminal helper isn't installed there, `open` installs it from the plugin and tells you to reload the window once, instead of opening a terminal window you didn't ask for. A terminal window is used only outside an editor or when you ask (`--in window`).
- Profiles are understood as people say them: `fuuk`, `claude-fuuk`, `claude fuuk`, "the fuuk app".

**Shorter commands**
- `/crosstalk <profile> [message]` opens a session. `/crosstalk to <who> <message>` sends without a model turn. `/crosstalk where` shows or sets where `open` puts a session (it replaces `open-in` and takes `panel` and `editor` too). `/crosstalk help` lists the rest; plain `/crosstalk` is now short. The old commands still work.
- The `open` tool's description is shorter and tells the model not to pick where a session opens.

**Notifications that open the right window (Windows)**
- A session in an account's app window (not the main one) now raises its own notification when a turn finishes, or when it needs a permission, answers a question or approves a plan. Clicking it opens that window on that session. The app's own notifications all belong to one app identity, so a click always went to the main window's last session.
- `/crosstalk setup yes` (or `app-windows\install.ps1`) installs it for this user only: a notification helper and a notification name per window. `install.ps1 -Uninstall` removes the names.
- To avoid doubles, turn off "task complete" and set permission and question notifications to badge in each account window's own Settings. The main window keeps its own.

**Sessions know their window, and `open` needs no profile**
- `open` no longer needs a profile. With none, it starts this session's own profile, so "open a different session" stays on the account you're working in. A profile you name still wins.
- On Windows, Crosstalk finds the desktop-app window a session runs in from its parent processes. A Terminal-panel tab counts as its window's, so a `mikey` session in a tab of the `fuuk` window is "in the fuuk app window". `list` and `/crosstalk` show it, and `/crosstalk open window` (or the `open` tool with `profile: "window"`) starts that window's account. If the window can't be found, Crosstalk says so and doesn't guess. `CLAUDE_CROSSTALK_WINDOW` overrides it.
- `claude-new-session.ps1 here ...` opens in the window you're in, and `-DryRun` shows which window it would use and why, without opening anything. The `move-chat` skill uses `here` for "use a different session", and asks which account to use when the reason is a usage limit and you didn't name one.

## 1.7.0

**Usage guard**
- At 93% of any usage limit (5-hour, weekly, or a gateway's spend limit), every session on that account stops its turn, compacts, writes the summary to `handoffs/` in the shared folder, shows it, and asks whether to move to another account. It offers up to three other profiles, lowest usage first. Picking one opens it in the same folder, reading the handoff. The first session to see it tells the rest through `usage/<profile>.json`, so idle sessions stop too. Sessions over the limit hold their wake-ups until the window resets.
- Big sessions can move earlier: a session whose context is 60% full stops at 85% (`/crosstalk usage large`), `/crosstalk usage here <n>` sets one session's own point, and `/crosstalk move <profile>` moves a session right away.
- `/crosstalk usage` shows each account's last known usage and where this session stops, and `/crosstalk usage <n|off>` (or `CLAUDE_CROSSTALK_USAGE_STOP`) sets the account point.

**Moved sessions work alone when the old one is out of usage**
- A session moved because its account hit the limit is told it owns the work alone: it shouldn't message the old session, and should ask you in its own chat if it's blocked. A move with plenty of usage left keeps the old wording: report back only if blocked or when done.
- `send` still delivers to a session that's paused for usage, but its reply says that session won't answer before its limit resets. `list` marks such sessions, and its first line now shows this session's own usage. The `move-chat` skill reads that line to choose the wording.

## 1.6.0

Crosstalk now works properly with the **Claude desktop app**, as well as in terminals and VS Code. The [desktop app guide](docs/desktop-app.md) covers it.

**Sessions on another account, from the app**
- From a session in the desktop app, `/crosstalk open <profile>` starts that profile in a new tab of the app's **Terminal panel**, so it runs inside the app on that profile's own login and subscription. There's nothing to install: Crosstalk uses the app's own Terminal tool, and the app asks you to approve the command. `auto` picks this whenever the session runs in the app. `/crosstalk open-in app` sets it, and `/crosstalk open-in window` goes back to a separate terminal window.
- A session opened this way keeps its transcript, so it can be resumed and gets a title. The panel's shell inherits a marker from the app that otherwise turns transcript saving off, so Crosstalk sets `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` on the line it types.
- A session opened this way is found even when its shell reports the folder at the app's packaged path (`AppData\Local\Packages\…\LocalCache\Roaming`), so your first message still reaches it.

**A full app window per account (Windows, optional)**
- New `app-windows/` folder. Its scripts run a second copy of the desktop app signed in to another account, with its own sidebar, sessions and usage, open a session in that window with the folder and prompt filled in, and press Send for you. A `move-chat` skill hands a whole chat to another account through a handoff file. `app-windows\install.ps1` installs it all and makes Start-menu shortcuts.

**Sessions go by their real name**
- `list`, `/crosstalk`, the "is up" notice and arriving messages show each session's title with its address: `Review the PR (work/review-the-pr-1a2b)`. In the app, the title is the one in the sidebar. In a terminal, it's the title Claude Code gave the session or the one you set with `/rename`. Titles are checked every 15 seconds, so renames show up.
- Addresses are made from the title too. A session with no title yet goes by its folder, and keeps answering to that folder address after it's named.
- `send` accepts a session's title when only one session has it.
- Titles are found for a second copy of the app as well (`--user-data-dir`, such as `~/.claude-<profile>-app`). If a title isn't found, set `CLAUDE_CROSSTALK_APP_DATA` to that copy's data folder. A record that names another Claude Code session is ignored, so a terminal that inherited the app's variables doesn't take the app's title.

**Smaller**
- `/crosstalk open-in` skips the editor-helper check when `open` won't use an editor tab.

## 1.5.0 (never released on its own; included in 1.6.0)

- The Terminal-panel `open` above.

## 1.4.1

- `open` works in VSCodium. Each session spots its editor from the terminal it runs in: VSCodium's terminal gets the new session as a VSCodium tab, through `codium` and a `vscodium://` link, and VS Code's as before. Install the helper in VSCodium with `codium --install-extension <the plugin's folder>/vscode/crosstalk-terminal-0.3.0.vsix`.
- `/crosstalk editor auto|code|codium` pins the editor, and `CLAUDE_CROSSTALK_EDITOR` overrides that.
- `/crosstalk open-in` on its own now says what `open` will do from this session and why: which editor it spotted, whether the helper is installed, and the install command with the real folder when it isn't.
- Messages name the editor they mean, so a missing helper in VSCodium says VSCodium.

## 1.4.0

- `/crosstalk open <profile> --model <m> --mode <p> [message]`: the slash command can set the new session's model and permission mode too. Modes are matched whatever their case.
- `open` works on macOS and Linux. On macOS it opens a Terminal window. On Linux it opens a new tmux window when you're in tmux, otherwise the first desktop terminal it finds; `CLAUDE_CROSSTALK_TERMINAL` picks one. On macOS, Crosstalk waits up to two minutes for the first-time "control Terminal?" prompt, and says where to allow it if it's refused.
- The `open check` workflow runs the tests and a real `open` on GitHub's macOS and Linux runners, on pull requests and on request. `scripts/open-check.mjs` does the real check, with a throwaway shortcut and no login. The tests now pass on macOS and Linux as well as Windows.
- A `/vm` skill in the repo starts Linux (WSL) or a macOS runner to test on.
- The folder-trust mark is read back after it's written and put back if a session already running on that profile wrote over it.
- `scripts/install-local.mjs` installs the committed code on every profile on this computer, from whichever marketplace each one uses.

## 1.3.0

- The `open` tool takes `model` and `permissionMode`, so the model can start a session on, say, Sonnet in plan mode. Left out, the profile's own launch command is used. `bypassPermissions` isn't offered (build choice); a profile's saved `/crosstalk launch` command can still include it.
- `open` marks the folder as trusted in the profile it starts, so a profile that hasn't opened this folder before no longer waits at "Is this a project you trust?" and misses its first message. Build choice: the opening session already runs in this folder, so the trust is carried over only to the session you asked for. If the record can't be updated, the session still opens and Crosstalk says it may stop at the trust screen.

## 1.2.0

- Every message that arrives is shown to you in the transcript, idle or mid-turn, so you see replies without asking. The model is told you've seen it, so it doesn't repeat it back.
- `/crosstalk open <profile> [message]`, and an `open` tool for the model: starts a session on another profile in a new terminal in the same folder, then sends it the message once it's up.
- `open` uses a new VS Code terminal tab when you're in VS Code, through a small helper extension in `vscode/`, and otherwise a new Windows Terminal window. By default the tab opens to the right of your terminal tabs at the top. The VS Code settings `crosstalkTerminal.location` (`right`, `beside`, `split`, `bottom`) and `crosstalkTerminal.focus` change that. `/crosstalk open-in` and `CLAUDE_CROSSTALK_OPEN_IN` choose where it opens.
- `/crosstalk launch <profile> <command>` saves how a profile starts, such as `claude zai`. Only commands that start Claude Code are allowed.

## 1.1.0

- `/crosstalk setup` finds your profiles, however they're laid out, shows what it would do, and with `yes` installs Crosstalk on each and adds shortcuts.
- `/crosstalk setup add`, `skip` and `name` correct the list. `/crosstalk add <name>` makes a new profile.
- The wake-up limit is now the `CLAUDE_CROSSTALK_WAKE_LIMIT` variable, so installing no longer leaves an unset option to configure.
- Clearer, symmetrical diagrams and easier-to-read badges.

## 1.0.1

- New look: banner, logo, plugin icon and redrawn diagrams.
- README: clearer install steps, a section on multiple Claude accounts, which providers are tested and how others connect, and troubleshooting.

## 1.0.0

- First release: Claude Code sessions message each other across profiles, accounts and AI providers on one computer.
