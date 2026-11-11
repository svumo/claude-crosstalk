// The environment Copilot's process is given: an allow-list. Pure.
//
// COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN are left out on purpose. Copilot prefers any of
// them to its own stored login, so a token lying in the environment would switch accounts without
// a word. With none, it uses the login the person made with `copilot login`, from the OS keychain.

const ALLOWED = new Set([
  // finding programs and the user's folders
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "USER", "USERNAME", "LOGNAME", "SHELL",
  // language and terminal
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  // where Copilot keeps its settings, and how it reaches the keychain on Linux
  "COPILOT_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  // a proxy and its certificates, where the network needs them
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
]);

// Names differ in case on Windows (Path, ComSpec), so they are compared in upper case.
export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && ALLOWED.has(name.toUpperCase())) {
      kept[name] = value;
    }
  }
  return kept;
}
