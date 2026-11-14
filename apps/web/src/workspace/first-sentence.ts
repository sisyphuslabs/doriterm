/**
 * The first sentence of a notice: what happened, without what to do about it. A status bar has one line, so it shows
 * this beside its action and keeps the whole notice in the item's title and accessible name; a cut-off sentence would
 * lose its end (DESIGN.md 5 (e)).
 */
export function firstSentence(text: string): string {
  const end = text.search(/[.!?](\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}
