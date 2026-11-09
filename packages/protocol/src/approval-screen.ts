import { readClaudePrompt } from "./approval-claude.ts";
import { readCodexPrompt } from "./approval-codex.ts";
import type { PromptReader, ScreenPrompt } from "./approval-rows.ts";

export type { ApprovalAnswer, PromptKind, PromptOption, PromptStep, ScreenPrompt } from "./approval-rows.ts";

/** Readers by the `app` an agent names itself in its OSC 7501 record. Another agent has no reader and no answer here. */
const READERS: Readonly<Record<string, PromptReader>> = {
  "claude-code": readClaudePrompt,
  codex: readCodexPrompt,
};

/** Whether an agent that names itself `app` has a reader here, so its prompts get a card (#192) rather than bare keys (#1527). */
export const hasPromptReader = (app: string): boolean => Object.hasOwn(READERS, app);

/** The prompt on a `terminal.read` screen, read by the parser of the agent that reported `app`. */
export function readScreenPrompt(app: string, screen: string): ScreenPrompt | undefined {
  const reader = Object.hasOwn(READERS, app) ? READERS[app] : undefined;
  return reader?.(screen.split("\n").map((line) => line.trimEnd()));
}
