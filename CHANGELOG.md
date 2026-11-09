# Changelog

## Unreleased

- Sessions are listed by their real name: a desktop-app session by its title in the app's sidebar, a terminal session by the title Claude Code gave it or the one set with `/rename`. `list`, `/crosstalk`, the "is up" notice and arriving messages show it, as `Claude Fuuk for next task (default/claude-fuuk-next-task-b128f8-730f)`. Each session checks its title on the 15-second heartbeat, so a rename shows up there too.
- The app title is read from the app's record of the session, in the data folder of the app copy that started it (found from where its Claude Code runs), so a second copy started with `--user-data-dir` works. `~/.claude-<profile>-app` and the standard folders are tried next, and `CLAUDE_CROSSTALK_APP_DATA` names one by hand. A record that names another Claude Code session is ignored, so a terminal that inherited the app's variables doesn't take its title.
- `send` takes a session's title when only one session has it. Addresses don't change.

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
