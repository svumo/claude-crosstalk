// Which git to run. On Windows that is Git for Windows, even when another git comes first on PATH.
//
// An MSYS2 build of git (devkitPro ships one, and puts it on PATH) is no use here: it expands
// braces in its arguments, so `<sha>^{commit}` reaches git as `<sha>^commit`, and it answers with
// POSIX paths (`/home/<user>/...` for C:\Users\<user>\...) that Node cannot open. Git for Windows
// says so in its version (`git version 2.53.0.windows.2`), which is how it is told apart.
//
// The search is pure apart from `probe`, so the mod (through the engine) and the sidecar (through
// Node) share it.

export type GitProbe = {
  exists(path: string): Promise<boolean>;
  // `git --version` from that file, or null when it does not run.
  version(path: string): Promise<string | null>;
};

export type GitPlaces = { platform: string; path: string; programFiles: string[]; localAppData: string };

export const isGitForWindows = (version: string | null): boolean => /^git version \S*\.windows\.\d+/.test((version ?? "").trim());

// Every git.exe worth asking, in order: each on PATH, then where Git for Windows installs. Pure.
export function gitCandidates(places: GitPlaces): string[] {
  const dirs = places.path.split(";").map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const installs = [...places.programFiles.filter(Boolean).map((p) => `${p}\\Git\\cmd`), places.localAppData ? `${places.localAppData}\\Programs\\Git\\cmd` : ""];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...dirs, ...installs].filter(Boolean)) {
    const file = `${dir.replace(/[\\/]+$/, "")}\\git.exe`;
    const key = file.replace(/\//g, "\\").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

// The git to run: "git" off Windows, else the first Git for Windows found, else plain "git" (so
// whatever is on PATH still gets its chance, and its errors are the ones shown).
export async function findGit(places: GitPlaces, probe: GitProbe): Promise<string> {
  if (places.platform !== "win32") {
    return "git";
  }
  for (const file of gitCandidates(places)) {
    if ((await probe.exists(file)) && isGitForWindows(await probe.version(file))) {
      return file;
    }
  }
  return "git";
}
