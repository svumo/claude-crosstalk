// The plain-language `text` of a message: what a v0 peer, the transcript and a terminal show.
// Pure. Everything Copilot wrote is quoted as Copilot's, never stated as fact.

import type { PermissionRequestBody, ReplyBody, Usage } from "./schema.ts";

export function usageLine(usage: Usage): string {
  const credits = usage.credits === null ? "credits unknown for this model" : `${usage.credits.toFixed(1)} AI credits`;
  return `${usage.prompts} ${usage.prompts === 1 ? "prompt" : "prompts"}, ${credits} (${usage.input_tokens} in, ${usage.cached_tokens} cached, ${usage.output_tokens} out)`;
}

const OUTCOMES: Record<ReplyBody["outcome"], string> = {
  completed: "finished",
  failed: "failed",
  cancelled: "was stopped",
  refused: "was refused",
};

export function replyText(body: ReplyBody): string {
  const lines = [
    `Copilot task ${body.task_id} ${OUTCOMES[body.outcome]}.`,
    "",
    "What Copilot reported (its own words, not checked):",
    body.summary.trim() === "" ? "(nothing)" : body.summary.trim(),
  ];
  if (body.branch !== "") {
    lines.push(
      "",
      `Branch ${body.branch}, worktree ${body.worktree}, cut from ${body.base_sha.slice(0, 12)}.`,
      body.diff_stat.trim() === "" ? "No changes on the branch." : body.diff_stat.trim(),
      "",
      `Review:  ${body.commands.review}`,
      `Merge:   ${body.commands.merge}`,
      `Discard: ${body.commands.discard}`,
    );
  }
  lines.push("", `Used: ${usageLine(body.usage)}.`);
  return lines.join("\n");
}

const WHAT: Record<PermissionRequestBody["tool_kind"], string> = {
  read: "read",
  write: "write to",
  shell: "run a shell command",
  network: "use the network",
  other: "use a tool",
};

// What exactly would run or be touched: the command, the paths or the URL.
export function permissionTarget(body: PermissionRequestBody): string {
  if (body.command !== undefined && body.command !== "") {
    return body.command;
  }
  if (body.url !== undefined && body.url !== "") {
    return body.url;
  }
  return (body.paths ?? []).join(", ") || body.title;
}

export function permissionText(body: PermissionRequestBody): string {
  const scope = { worktree: "inside its worktree", outside: "OUTSIDE its worktree", none: "" }[body.scope];
  const lines = [
    `Copilot task ${body.task_id} asks to ${WHAT[body.tool_kind]}${scope ? ` ${scope}` : ""} (${body.risk} risk):`,
    `  ${permissionTarget(body)}`,
    `Only you can answer: /copilot approve ${body.request_id}${body.task_grant ? `, /copilot allow ${body.request_id} (${body.task_grant}, for this task)` : ""} or /copilot deny ${body.request_id}.`,
  ];
  return lines.join("\n");
}
