// Crosstalk terminal: opens a terminal in this VS Code window for a Crosstalk `/crosstalk open`.
//
// Crosstalk calls `code --open-url vscode://svumo.crosstalk-terminal/open?d=<base64url JSON>`, the
// JSON holding { name, cwd, cmd }. Only a command that starts Claude Code is run: `claude`, maybe
// followed by plain words, so a link from anywhere else can't run anything else through it.
//
// Where it opens is the setting crosstalkTerminal.location. `auto`: beside your terminal tabs in
// the editor area, as their + button does, when you keep terminals there; else the bottom panel.

const vscode = require("vscode");

const SAFE_COMMAND = /^claude(?:-[A-Za-z0-9_-]+)?(?: [A-Za-z0-9_.-]+)*$/;

function decode(query) {
  const d = new URLSearchParams(query).get("d") ?? "";
  const json = Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

const isTerminalTab = (tab) => tab.input instanceof vscode.TabInputTerminal;

// The editor group holding terminal tabs: the active one if it has any, else the first that does.
function terminalGroup() {
  const groups = vscode.window.tabGroups;
  if (groups.activeTabGroup.tabs.some(isTerminalTab)) {
    return groups.activeTabGroup;
  }
  return groups.all.find((g) => g.tabs.some(isTerminalTab));
}

function locationFor(setting) {
  if (setting === "panel") {
    return vscode.TerminalLocation.Panel;
  }
  if (setting === "split" && vscode.window.activeTerminal) {
    return { parentTerminal: vscode.window.activeTerminal };
  }
  const group = terminalGroup();
  if (setting === "editor" || group) {
    return { viewColumn: group ? group.viewColumn : vscode.ViewColumn.Active, preserveFocus: false };
  }
  return vscode.TerminalLocation.Panel;
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
      const setting = vscode.workspace.getConfiguration("crosstalkTerminal").get("location", "auto");
      const terminal = vscode.window.createTerminal({
        name: String(ask.name ?? "claude").slice(0, 40),
        cwd: ask.cwd ? String(ask.cwd) : undefined,
        location: locationFor(setting),
      });
      terminal.show();
      terminal.sendText(cmd);
    },
  }));
}

function deactivate() {}

module.exports = { activate, deactivate, SAFE_COMMAND };
