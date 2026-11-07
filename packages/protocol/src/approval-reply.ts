import type { ApprovalAnswer, PromptOption, ScreenPrompt } from "./approval-rows.ts";

/**
 * What a person answered a prompt with. option: one row. text: a row that takes typed text, and the text. checked: a
 * multi-select dialog's rows to leave checked, then its submit. cancel: the dialog's own cancel key.
 */
export type PromptReply =
  | { readonly kind: "option"; readonly option: string }
  | { readonly kind: "text"; readonly option: string; readonly text: string }
  | { readonly kind: "checked"; readonly options: readonly string[] }
  | { readonly kind: "cancel" };

/** The longest typed answer sent; an agent's input box is no place for a document. */
export const MAX_TYPED_ANSWER = 2000;

/**
 * Typed text as it is pasted: one line (an agent submits on Enter, so a line break would send half of it), no
 * control characters (an escape sequence could press keys the person never chose), at most MAX_TYPED_ANSWER long.
 * Undefined when nothing is left.
 */
export function typedAnswer(text: string): string | undefined {
  const line = text
    // oxlint-disable-next-line no-control-regex -- the control characters are exactly what is taken out
    .replaceAll(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TYPED_ANSWER);
  return line === "" ? undefined : line;
}

const optionOf = (prompt: ScreenPrompt, id: string): PromptOption | undefined =>
  prompt.options.find((option) => option.id === id);

/** Whether the reply is one this prompt takes: a row it has, typed text only for a typed row, boxes only when multi. */
export function replyFits(prompt: ScreenPrompt, reply: PromptReply): boolean {
  switch (reply.kind) {
    case "option": {
      const option = optionOf(prompt, reply.option);
      return option !== undefined && !option.typed && (option.checked === undefined || !prompt.multi);
    }
    case "text":
      return optionOf(prompt, reply.option)?.typed === true && typedAnswer(reply.text) !== undefined;
    case "checked":
      return (
        prompt.multi &&
        prompt.submit !== undefined &&
        reply.options.every((id) => optionOf(prompt, id)?.checked !== undefined)
      );
    case "cancel":
      return prompt.cancel !== undefined;
  }
}

/** How the answer is recorded for a client that only knows Allow and Deny: a decline, or any other choice. */
export function replyClass(prompt: ScreenPrompt, reply: PromptReply): ApprovalAnswer {
  if (reply.kind === "cancel") return "deny";
  if (reply.kind === "checked") return "allow";
  return optionOf(prompt, reply.option)?.declines === true ? "deny" : "allow";
}

/** The answer in the agent's own words, as "answered" shows it: a row's label, the checked rows, or the cancel. */
export function replyLabel(prompt: ScreenPrompt, reply: PromptReply): string {
  switch (reply.kind) {
    case "option":
    case "text":
      return optionOf(prompt, reply.option)?.label ?? reply.option;
    case "checked":
      return reply.options.map((id) => optionOf(prompt, id)?.label ?? id).join(", ") || "None";
    case "cancel":
      return prompt.cancel?.label ?? "Cancel";
  }
}

const words = (prompt: ScreenPrompt, id: string) => {
  const option = optionOf(prompt, id);
  return option === undefined ? undefined : `${option.label}\n${option.detail ?? ""}`;
};

/**
 * The rows a reply's keys pick on the live screen carry the words the card showed for them: the chosen row, every box
 * a multi-select answer may toggle, or the cancel. A card that showed other words for a row would answer with a
 * choice the person never saw, so nothing is pressed (#776).
 */
export function replyShown(shown: ScreenPrompt, now: ScreenPrompt, reply: PromptReply): boolean {
  switch (reply.kind) {
    case "option":
    case "text":
      return words(shown, reply.option) !== undefined && words(shown, reply.option) === words(now, reply.option);
    case "checked":
      return now.options
        .filter((option) => option.checked !== undefined)
        .every((option) => words(shown, option.id) === words(now, option.id));
    case "cancel":
      return shown.cancel?.key === now.cancel?.key && shown.cancel?.label === now.cancel?.label;
  }
}

/** ↓ or ↑ from the cursor's row to `target`, in the order the rows are drawn; undefined without a cursor on screen. */
function reach(prompt: ScreenPrompt, target: string): string[] | undefined {
  const ids = prompt.options.map((option) => option.id);
  const from = prompt.cursor === undefined ? -1 : ids.indexOf(prompt.cursor);
  const to = ids.indexOf(target);
  if (from === -1 || to === -1) return undefined;
  return Array.from({ length: Math.abs(to - from) }, () => (to > from ? "down" : "up"));
}

/**
 * The agent's keys for a reply, worked out on the prompt as the live screen shows it right before they are pressed
 * (where the cursor is, which boxes are checked). Typed text is not among them: it is pasted once its row is open.
 * Undefined when the reply cannot be pressed on this screen.
 */
export function replyKeys(now: ScreenPrompt, reply: PromptReply): readonly string[] | undefined {
  if (!replyFits(now, reply)) return undefined;
  switch (reply.kind) {
    case "option":
    case "text": {
      const option = optionOf(now, reply.option);
      if (option === undefined) return undefined;
      const keys = option.keys.length > 0 ? option.keys : reach(now, option.id);
      return keys === undefined ? undefined : [...keys, ...option.open];
    }
    case "checked": {
      const wanted = new Set(reply.options);
      const toggles = now.options
        .filter((option) => option.checked !== undefined && option.checked !== wanted.has(option.id))
        .flatMap((option) => option.keys);
      return now.submit === undefined ? undefined : [...toggles, now.submit];
    }
    case "cancel":
      return now.cancel === undefined ? undefined : [now.cancel.key];
  }
}

/**
 * Allow or Deny as a reply, for a client that offers only those two (a notification's actions): Allow is the plain
 * "Yes" row (Claude Code's `Yes`, Codex's `Yes, proceed`), Deny the dialog's cancel. Undefined when the prompt has no
 * such row, so nothing is pressed for it.
 */
export function binaryReply(prompt: ScreenPrompt, answer: ApprovalAnswer): PromptReply | undefined {
  if (answer === "deny") return prompt.cancel === undefined ? undefined : { kind: "cancel" };
  if (prompt.kind !== "permission") return undefined;
  const yes = prompt.options.find((option) => option.label === "Yes" || option.label === "Yes, proceed");
  return yes === undefined ? undefined : { kind: "option", option: yes.id };
}
