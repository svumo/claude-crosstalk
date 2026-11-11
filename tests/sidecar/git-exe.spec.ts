// Choosing Git for Windows over an MSYS2 git that comes first on PATH.

import assert from "node:assert/strict";
import { test } from "node:test";

import { findGit, gitCandidates, isGitForWindows } from "../../copilot/context/git-exe.ts";
import type { GitPlaces } from "../../copilot/context/git-exe.ts";

const places = (path: string): GitPlaces => ({ platform: "win32", path, programFiles: ["C:\\Program Files"], localAppData: "C:\\Users\\me\\AppData\\Local" });

const VERSIONS: Record<string, string> = {
  "c:\\devkitpro\\msys2\\usr\\bin\\git.exe": "git version 2.49.0\n",
  "c:\\program files\\git\\cmd\\git.exe": "git version 2.53.0.windows.2\n",
};
const probe = {
  exists: async (path: string) => path.toLowerCase() in VERSIONS,
  version: async (path: string) => VERSIONS[path.toLowerCase()] ?? null,
};

test("Git for Windows is told apart by its version", () => {
  assert.equal(isGitForWindows("git version 2.53.0.windows.2\n"), true);
  assert.equal(isGitForWindows("git version 2.49.0"), false);
  assert.equal(isGitForWindows(null), false);
});

test("an MSYS2 git first on PATH is passed over for Git for Windows", async () => {
  assert.equal(await findGit(places("C:\\devkitPro\\msys2\\usr\\bin;C:\\Program Files\\Git\\cmd"), probe), "C:\\Program Files\\Git\\cmd\\git.exe");
});

test("Git for Windows is found where it installs even when it is not on PATH", async () => {
  assert.equal(await findGit(places("C:\\devkitPro\\msys2\\usr\\bin"), probe), "C:\\Program Files\\Git\\cmd\\git.exe");
});

test("with no Git for Windows anywhere, plain git is run; off Windows, always", async () => {
  const none = { exists: async () => true, version: async () => "git version 2.49.0" };
  assert.equal(await findGit(places("C:\\devkitPro\\msys2\\usr\\bin"), none), "git");
  assert.equal(await findGit({ ...places(""), platform: "linux" }, probe), "git");
});

test("candidates come once each, PATH first, quotes and trailing slashes tidied", () => {
  const found = gitCandidates(places("\"C:\\Program Files\\Git\\cmd\\\";C:\\x;c:\\program files\\git\\cmd"));
  assert.deepEqual(found, ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\x\\git.exe", "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe"]);
});
