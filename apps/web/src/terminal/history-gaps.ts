interface HistoryCount {
  getScrollbackCount(): number;
  getScrollbackDiscardedCount?(): number;
}

interface GapView {
  readonly bridge: HistoryCount | null;
}

/**
 * Where a reattach may have lost output, per view. hc's attach has no cursor to resume from (#2033,
 * herdrdev/herdr-core#233), so a reattach to a view the core painted repaints the screen alone (#1997): output that
 * scrolled off the core's screen while the line was down never reaches the history. Each place is the count of lines the
 * view had pushed into history when the repaint began, discarded ones included, so it stays between the same two lines
 * as history grows and as its oldest lines are dropped.
 */
const gaps = new WeakMap<GapView, number[]>();

const pushed = (bridge: HistoryCount): number =>
  bridge.getScrollbackCount() + (bridge.getScrollbackDiscardedCount?.() ?? 0);

/** Marks the top of the view's screen as it is now, just before the core's repaint replaces the screen. */
export function markHistoryGap(view: GapView): void {
  if (view.bridge === null) return;
  const at = pushed(view.bridge);
  const marks = gaps.get(view) ?? [];
  // Reattaches with no line between them leave one place.
  if (marks.at(-1) !== at) marks.push(at);
  gaps.set(view, marks);
}

/**
 * The marked places as rows from the top of the history the view holds now, oldest first. A place whose lines above were
 * all discarded stays at row 0; one past the history the view holds (the history was cleared) is forgotten.
 */
export function historyGapRows(view: GapView): number[] {
  const marks = gaps.get(view);
  if (view.bridge === null || marks === undefined) return [];
  const discarded = view.bridge.getScrollbackDiscardedCount?.() ?? 0;
  const held = view.bridge.getScrollbackCount();
  const rows = marks.map((at) => Math.max(0, at - discarded)).filter((row) => row <= held);
  if (rows.length !== marks.length)
    gaps.set(
      view,
      rows.map((row) => row + discarded),
    );
  return rows;
}
