import { FIND_CURRENT_CLASS, FIND_MATCH_CLASS, FindBar } from "@doriface/ui";
import type { WTerm } from "@wterm/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { findMatches, type FindMatch, MatchCache, matchAtOrBefore, stepMatch } from "./find.ts";
import type { CellSource } from "./links.ts";
import { scrollTopAtRow, type ScrollBox } from "./scrollbar.ts";
import type { TerminalScroll } from "./terminal-scroll.tsx";

/** Each terminal's last query, so reopening its find bar shows it selected (herdr-app keeps one per terminal). */
const queries = new Map<string, string>();

/** The absolute row at the bottom of the view. */
const bottomRow = (box: ScrollBox): number => Math.floor(box.scrollTop / box.rowHeight) + box.rows - 1;

const search = (wt: WTerm, query: string): FindMatch[] => {
  const core: CellSource | null = wt.bridge;
  return core === null ? [] : findMatches(core, query);
};

interface Mark {
  readonly key: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly current: boolean;
}

/** Where each run of the matches in view is drawn, relative to the terminal's wrapper, as links are underlined. */
function marksOf(wt: WTerm, matches: readonly FindMatch[], current: number | null, box: ScrollBox): Mark[] {
  const grid = wt.element.querySelector<HTMLElement>(".term-row:not(.term-scrollback-row)");
  const wrapper = wt.element.parentElement;
  const cell = parseFloat(getComputedStyle(wt.element).getPropertyValue("--term-cell-width")) || 0;
  if (grid === null || wrapper === null || cell <= 0) return [];
  const rows = grid.getBoundingClientRect();
  const origin = wrapper.getBoundingClientRect();
  const top = Math.floor(box.scrollTop / box.rowHeight);
  const marks: Mark[] = [];
  matches.forEach((match, index) => {
    for (const run of match.runs) {
      if (run.row < top - 1 || run.row > top + box.rows) continue;
      marks.push({
        key: `${index}:${run.row}:${run.start}`,
        left: rows.left - origin.left + run.start * cell,
        top: rows.top - origin.top + (run.row - box.scrollback) * rows.height,
        width: (run.end - run.start) * cell,
        height: rows.height,
        current: index === current,
      });
    }
  });
  return marks;
}

export interface TerminalFindProps {
  readonly wt: WTerm;
  readonly address: string;
  readonly scroll: TerminalScroll;
  /** Counts the output written to the terminal; the search reads the cells again only when it moves. */
  readonly written: RefObject<number>;
  /** Goes up each time the find bar is asked for, so asking again while it is open selects the query again. */
  readonly opened: number;
  readonly onClose: () => void;
}

/**
 * herdr-app's terminal.search (#732): a find bar over the terminal that searches its screen and scrollback and marks
 * every match in view without touching the text selection. Enter and Shift+Enter step (wrapping) and bring the
 * current match into view; Escape closes it and the terminal takes the keyboard back.
 */
export function TerminalFind({ wt, address, scroll, written, opened, onClose }: TerminalFindProps) {
  const [query, setQuery] = useState(() => queries.get(address) ?? "");
  const box = scroll.view?.box ?? null;
  // Each published frame (a scroll or a write) draws again; only new output or a new query searches again.
  const cache = useRef(new MatchCache());
  const matches = box === null ? [] : cache.current.get(written.current, query, (next) => search(wt, next));
  const [current, setCurrent] = useState<number | null>(() =>
    box === null ? null : matchAtOrBefore(search(wt, query), bottomRow(box)),
  );
  const at = current !== null && current < matches.length ? current : matches.length > 0 ? matches.length - 1 : null;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [opened]);

  const reveal = (index: number | null, list: readonly FindMatch[]): void => {
    setCurrent(index);
    const row = index === null ? undefined : list[index]?.row;
    if (row === undefined || box === null) return;
    const top = Math.floor(box.scrollTop / box.rowHeight);
    if (row >= top && row < top + box.rows) return;
    wt.element.scrollTop = scrollTopAtRow(box, row - Math.floor(box.rows / 2));
  };
  const onQueryChange = (next: string): void => {
    queries.set(address, next);
    setQuery(next);
    const found = search(wt, next);
    reveal(box === null ? null : matchAtOrBefore(found, bottomRow(box)), found);
  };
  const step = (direction: 1 | -1): void => reveal(stepMatch(matches.length, at, direction), matches);

  return (
    <>
      {box === null
        ? null
        : marksOf(wt, matches, at, box).map((mark) => (
            <span
              key={mark.key}
              aria-hidden
              data-find-match={mark.current ? "current" : ""}
              className={`pointer-events-none absolute ${mark.current ? FIND_CURRENT_CLASS : FIND_MATCH_CLASS}`}
              style={{ left: mark.left, top: mark.top, width: mark.width, height: mark.height }}
            />
          ))}
      <FindBar
        inputRef={input}
        query={query}
        onQueryChange={onQueryChange}
        result={query === "" ? null : { current: at, total: matches.length }}
        onNext={() => step(1)}
        onPrevious={() => step(-1)}
        onClose={onClose}
        className="absolute top-2 right-3 left-3 z-20 sm:left-auto sm:w-[22rem]"
      />
    </>
  );
}
