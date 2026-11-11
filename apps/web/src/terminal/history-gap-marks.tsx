import type { WTerm } from "@wterm/react";
import { historyGapRows } from "./history-gaps.ts";
import type { ScrollView } from "./terminal-scroll.tsx";

const GAP_LABEL = "Output from while the connection was down may be missing here";

/**
 * A dashed hairline across the grid between the history a view kept through a reconnect and the screen the core painted
 * after it, where output that scrolled off while the line was down is missing (#2033). The marks sit in a layer over the
 * grid's rows, clipped to them, that takes no pointer and no row of its own, so the grid's text and selection stay as
 * they are; on the alternate screen there is no history to mark.
 */
export function HistoryGapMarks({ wt, view }: { readonly wt: WTerm; readonly view: ScrollView }) {
  const rows = historyGapRows(wt);
  if (view.alt || rows.length === 0) return null;
  const { box } = view;
  return (
    <div
      className="pointer-events-none absolute left-0 overflow-hidden"
      style={{ top: view.padTop, right: view.lane, height: box.rows * box.rowHeight }}
    >
      {rows.map((row) => (
        <div
          key={row}
          role="separator"
          aria-label={GAP_LABEL}
          title={GAP_LABEL}
          data-history-gap={row}
          className="absolute inset-x-0 border-t border-dashed border-muted-foreground/60"
          style={{ top: row * box.rowHeight - box.scrollTop }}
        >
          <span className="absolute top-0 right-2 rounded-b-sm border border-t-0 border-border bg-popover px-1.5 text-2xs leading-4 text-muted-foreground">
            Output may be missing
          </span>
        </div>
      ))}
    </div>
  );
}
