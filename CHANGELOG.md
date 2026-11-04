# Changelog

## 1.2.0

- Every message that arrives is shown to you in the transcript, idle or mid-turn, so you see replies without asking. The model is told you've seen it, so it doesn't repeat it back.
- `/crosstalk open <profile> [message]`, and an `open` tool for the model: starts a session on another profile in a new terminal in the same folder, then sends it the message once it's up.
- `open` uses a new VS Code terminal tab when you're in VS Code, through a small helper extension in `vscode/`, and otherwise a new Windows Terminal window. The tab goes beside your editor-area terminal tabs if you keep terminals there; the VS Code setting `crosstalkTerminal.location` changes that. `/crosstalk open-in` and `CLAUDE_CROSSTALK_OPEN_IN` choose where it opens.
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
