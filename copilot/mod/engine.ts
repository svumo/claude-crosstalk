// The part of Claude Code's engine interface (`$`) that the Copilot hooks use, written out so
// they type-check on their own. The engine's own declarations are the authority; this names only
// the calls made here, and tests run them against the real engine.

export type RunResult = { exitCode: number; stdout: string; stderr: string };

export type Engine = {
  plugin: { root: string };
  ui: {
    toast(text: string): void;
    log(text: string): void;
    // The engine's own AskUserQuestion dialog; resolves to the label chosen, rejects when dismissed.
    ask(question: string, options?: readonly string[] | { options?: readonly string[]; header?: string }): Promise<string>;
    invalidate(event: string): void;
    resolve(e: unknown): { Box: (props: Record<string, unknown>) => unknown; Text: (props: Record<string, unknown>) => unknown; Svg?: (props: Record<string, unknown>) => unknown };
  };
  command: { register(spec: { name: string; description: string; argumentHint?: string }): Promise<unknown> };
  tool: { register(spec: { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred?: boolean }): Promise<unknown> };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    list(path: string): Promise<{ name: string; kind: string }[]>;
    stat(path: string): Promise<{ kind: string; size: number }>;
  };
  process: { run(argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }): Promise<RunResult> };
  env: { get(name: string): Promise<string | undefined> };
  clock: { now(): Promise<number>; every(ms: number, fn: () => unknown): unknown; after(ms: number, fn: () => void): { cancel(): void } };
  // One pasted image or document of the prompt.submit in flight, in base64 slices of up to 4 MiB.
  prompt: { media(args: { id: string; offset?: number }): Promise<PromptMedia> };
  session: { cwd(): Promise<string>; model(): Promise<string> };
};

// Who ran a command: the person's own Enter (or their bridge), or something else.
export type Origin = { kind?: string } | undefined;
export const isPerson = (origin: Origin): boolean => origin?.kind === "composer" || origin?.kind === "bridge";
// Claude running the command through Crosstalk's crosstalk_gh tool. The person asked for Claude to
// drive every command, approvals and setup included, so it counts the same as their own Enter.
export const CLAUDE_TOOL: Origin = { kind: "claude-tool" };
export const mayControl = (origin: Origin): boolean => isPerson(origin) || origin?.kind === CLAUDE_TOOL?.kind;

export type PromptMedia =
  | { type: "image" | "document"; mediaType: string; base64: string; size: number; next?: number; unreadable?: undefined; deny?: undefined }
  | { unreadable?: string; deny?: string; type?: undefined; base64?: undefined; next?: undefined };

// What prompt.submit carries that the Copilot hooks read: the slash command it ran, and what was pasted with it.
export type SubmitInput = {
  command?: { name: string; args: string };
  attachments?: readonly { type: string; mediaType?: string; filename?: string; id?: string }[];
};

export type CommandInput = { args?: string; origin?: Origin };
export type CommandAnswer = { text: string };

type Hook<E, R> = ($: Engine, e: E, next: (e: E) => Promise<R>) => Promise<R> | R;

// `on` as these hooks call it: an event, a matcher, and the hook.
export type On = {
  (event: "command.run", matcher: { command: string }, hook: Hook<CommandInput, CommandAnswer>): unknown;
  (event: "tool.call", matcher: { tool: string }, hook: Hook<{ file_path?: string; notebook_path?: string; args?: string; images?: unknown[]; folder?: unknown }, unknown>): unknown;
  (event: "ui.render", matcher: { component: string }, hook: Hook<RenderInput, unknown>): unknown;
};

export type RenderInput = { surface?: string; props?: { bodyColumns?: number; hasSurvey?: boolean } };
