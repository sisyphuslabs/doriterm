/**
 * What Paste invite answers (#2656): the clipboard's invite link, rebuilt by the shell, or why there is none. `gesture`
 * means the page asked without the person's own click or key just before; `not-invite` means the clipboard holds
 * anything else. Neither refusal carries any of the clipboard's text.
 */
export type PasteInviteAnswer = { readonly link: string } | { readonly refused: "gesture" | "not-invite" };

export function isPasteInviteAnswer(value: unknown): value is PasteInviteAnswer {
  if (typeof value !== "object" || value === null) return false;
  const refused: unknown = Reflect.get(value, "refused");
  return typeof Reflect.get(value, "link") === "string" || refused === "gesture" || refused === "not-invite";
}
