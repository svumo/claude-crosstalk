// The part of Claude Code's engine interface (`$`) that the Copilot hooks use, written out so
// they type-check on their own. The engine's own declarations are the authority; this names only
// the calls made here, and tests run them against the real engine.

export type RunResult = { exitCode: number; stdout: string; stderr: string };

export type Engine = {
  plugin: { root: string };
  ui: {
    toast(text: string): void;
    log(text: string): void;
    invalidate(event: string): void;
    resolve(e: unknown): { Box: (props: Record<string, unknown>) => unknown; Text: (props: Record<string, unknown>) => unknown };
  };
  command: { register(spec: { name: string; description: string; argumentHint?: string }): Promise<unknown> };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    list(path: string): Promise<{ name: string; kind: string }[]>;
    stat(path: string): Promise<{ kind: string; size: number }>;
  };
  process: { run(argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }): Promise<RunResult> };
  env: { get(name: string): Promise<string | undefined> };
  clock: { now(): Promise<number>; every(ms: number, fn: () => unknown): unknown };
  session: { cwd(): Promise<string>; model(): Promise<string> };
};

// Who ran a command: the person's own Enter (or their bridge), or something else.
export type Origin = { kind?: string } | undefined;
export const isPerson = (origin: Origin): boolean => origin?.kind === "composer" || origin?.kind === "bridge";

export type CommandInput = { args?: string; origin?: Origin };
export type CommandAnswer = { text: string };

type Hook<E, R> = ($: Engine, e: E, next: (e: E) => Promise<R>) => Promise<R> | R;

// `on` as these hooks call it: an event, a matcher, and the hook.
export type On = {
  (event: "command.run", matcher: { command: string }, hook: Hook<CommandInput, CommandAnswer>): unknown;
  (event: "tool.call", matcher: { tool: string }, hook: Hook<{ file_path?: string; notebook_path?: string }, unknown>): unknown;
  (event: "ui.render", matcher: { component: string }, hook: Hook<RenderInput, unknown>): unknown;
};

export type RenderInput = { props?: { bodyColumns?: number; hasSurvey?: boolean } };
