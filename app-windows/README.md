# A Claude desktop window per account (Windows)

These scripts run a second copy of the Claude desktop app signed in to another account, open sessions in it from anywhere, and move a whole chat from one account to another. Crosstalk carries the messages between them.

Install, from the plugin's folder:

```powershell
& .\app-windows\install.ps1 -Shortcuts work
```

Then open **Claude (work)** from the Start menu and sign in with the emailed code.

The full guide (sign-in, starting sessions, `move-chat`, limits, troubleshooting) is [docs/desktop-app.md](../docs/desktop-app.md).

| File | What it does |
|---|---|
| `install.ps1` | Copies the scripts to `~\.claude-crosstalk\app-windows\`, puts the skill in every profile, and makes Start-menu shortcuts |
| `claude-app.ps1` | Starts a profile's window, or brings it up |
| `claude-new-session.ps1` | Opens a session in a profile's window (or `here`, the window you're in) with the folder and prompt filled in, and with `-Send` sends it. `-DryRun` says which window it would use |
| `claude-press-send.ps1` | Presses Send in a profile's window through UI Automation |
| `claude-common.ps1` | Shared helpers: finds the app and a profile's window |
| `skills/move-chat/` | The skill that moves a chat to another account |
