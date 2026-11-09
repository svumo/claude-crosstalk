// Names for Copilot tasks. Pure, so the mod and the sidecar both use it.

const SLUG_MAX = 40;

// "Fix the login page!" -> "fix-the-login-page". Empty text gives "task".
export function taskSlug(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, SLUG_MAX).replace(/-+$/, "");
  return slug === "" ? "task" : slug;
}

// A task id: its slug and four characters that keep two tasks of one name apart.
export function taskId(text: string, random: string): string {
  return `${taskSlug(text)}-${random.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4).padEnd(4, "0")}`;
}

// What a task id may be, anywhere it becomes part of a path or a command line.
export const TASK_ID = /^[a-z0-9][a-z0-9-]{0,44}$/;

export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID.test(value);
}
