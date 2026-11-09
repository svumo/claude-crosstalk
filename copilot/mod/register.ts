// The Copilot part of Crosstalk's hooks module: the /copilot command and what follows from it.
//
// hooks.json names a single module, and the engine takes one unmatched hook per event across that
// module and everything it imports. So hooks/crosstalk.mjs keeps the session's own hooks and calls
// in here: registerCopilot(on) adds the hooks that carry a matcher, and startCopilot($) runs from
// its session.start.

import { taskId } from "../protocol/ids.ts";

export function registerCopilot(on: any): void {
  on("command.run", { command: "copilot" }, async (_$: any, e: any) => {
    return { text: `Copilot tasks are not built yet (${taskId(String(e.args ?? ""), "spike")}).` };
  });
}

export async function startCopilot($: any): Promise<void> {
  await $.command.register({ name: "copilot", description: "Hands a task to GitHub Copilot CLI in its own worktree. status shows what is running." });
}
