# Changelog

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
