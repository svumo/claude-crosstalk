// Crosstalk terminal: opens a terminal in this VS Code window for a Crosstalk `/crosstalk open`.
//
// Crosstalk calls `code --open-url vscode://svumo.crosstalk-terminal/open?d=<base64url JSON>`, the
// JSON holding { name, cwd, cmd }. Only a command that starts Claude Code is run: `claude`, maybe
// followed by plain words, so a link from anywhere else can't run anything else through it.

const vscode = require("vscode");

const SAFE_COMMAND = /^claude(?:-[A-Za-z0-9_-]+)?(?: [A-Za-z0-9_.-]+)*$/;

function decode(query) {
  const d = new URLSearchParams(query).get("d") ?? "";
  const json = Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

function activate(context) {
  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      if (uri.path !== "/open") {
        return;
      }
      let ask;
      try {
        ask = decode(uri.query);
      } catch {
        vscode.window.showWarningMessage("Crosstalk: that link couldn't be read.");
        return;
      }
      const cmd = String(ask.cmd ?? "");
      if (!SAFE_COMMAND.test(cmd)) {
        vscode.window.showWarningMessage(`Crosstalk only starts Claude Code, so it didn't run: ${cmd.slice(0, 80)}`);
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: String(ask.name ?? "claude").slice(0, 40),
        cwd: ask.cwd ? String(ask.cwd) : undefined,
      });
      terminal.show();
      terminal.sendText(cmd);
    },
  }));
}

function deactivate() {}

module.exports = { activate, deactivate, SAFE_COMMAND };
