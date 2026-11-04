// Crosstalk terminal: opens a terminal in this VS Code window for a Crosstalk `/crosstalk open`.
//
// Crosstalk calls `code --open-url vscode://svumo.crosstalk-terminal/open?d=<base64url JSON>`, the
// JSON holding { name, cwd, cmd }. Only a command that starts Claude Code is run: `claude`, maybe
// followed by plain words, so a link from anywhere else can't run anything else through it.
//
// Where it lands is the setting crosstalkTerminal.location, read on every open:
//   right   a new tab to the right, in the editor group with your terminal tabs (the default)
//   beside  a new editor column beside the current one
//   split   split beside the active terminal
//   bottom  the bottom terminal panel
// crosstalkTerminal.focus says whether the new tab takes focus.

const vscode = require("vscode");

const SAFE_COMMAND = /^claude(?:-[A-Za-z0-9_-]+)?(?: [A-Za-z0-9_.-]+)*$/;

function decode(query) {
  const d = new URLSearchParams(query).get("d") ?? "";
  const json = Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

const isTerminalTab = (tab) => tab.input instanceof vscode.TabInputTerminal;

// The editor group to add to: the active one if it holds a terminal tab, else the first that
// does, else the active one.
function terminalGroup() {
  const groups = vscode.window.tabGroups;
  if (groups.activeTabGroup.tabs.some(isTerminalTab)) {
    return groups.activeTabGroup;
  }
  return groups.all.find((g) => g.tabs.some(isTerminalTab)) ?? groups.activeTabGroup;
}

function locationFor(where, preserveFocus) {
  if (where === "bottom") {
    return vscode.TerminalLocation.Panel;
  }
  if (where === "split" && vscode.window.activeTerminal) {
    return { parentTerminal: vscode.window.activeTerminal };
  }
  if (where === "beside") {
    return { viewColumn: vscode.ViewColumn.Beside, preserveFocus };
  }
  return { viewColumn: terminalGroup().viewColumn, preserveFocus };
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
      const settings = vscode.workspace.getConfiguration("crosstalkTerminal");
      const where = settings.get("location", "right");
      const preserveFocus = !settings.get("focus", true);
      const terminal = vscode.window.createTerminal({
        name: String(ask.name ?? "claude").slice(0, 40),
        cwd: ask.cwd ? String(ask.cwd) : undefined,
        location: locationFor(where, preserveFocus),
      });
      terminal.show(preserveFocus);
      terminal.sendText(cmd);
    },
  }));
}

function deactivate() {}

module.exports = { activate, deactivate, SAFE_COMMAND };
