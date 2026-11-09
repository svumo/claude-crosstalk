# Changelog

## 1.6.0

Crosstalk now works properly with the **Claude desktop app**, as well as in terminals and VS Code. The [desktop app guide](docs/desktop-app.md) covers it.

**Sessions on another account, from the app**
- From a session in the desktop app, `/crosstalk open <profile>` starts that profile in a new tab of the app's **Terminal panel**, so it runs inside the app on that profile's own login and subscription. There's nothing to install: Crosstalk uses the app's own Terminal tool, and the app asks you to approve the command. `auto` picks this whenever the session runs in the app. `/crosstalk open-in app` sets it, and `/crosstalk open-in window` goes back to a separate terminal window.
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
