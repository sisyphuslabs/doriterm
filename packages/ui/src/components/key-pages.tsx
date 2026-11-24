import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";

const TOUCH_TARGET_PX = 44;

export interface KeyPagesProps {
  readonly items: readonly ReactNode[];
  /** Told the scroller's horizontal offset as it moves, so a bubble over one key can follow it. */
  readonly onScroll?: (left: number) => void;
}

const pagesOf = (items: readonly ReactNode[], perPage: number): readonly (readonly ReactNode[])[] =>
  Array.from({ length: Math.max(1, Math.ceil(items.length / perPage)) }, (_, page) =>
    items.slice(page * perPage, (page + 1) * perPage),
  );

function usePerPage(): [number, (element: HTMLDivElement | null) => void] {
  const [perPage, setPerPage] = useState(6);
  const node = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    node.current = element;
  }, []);
  useEffect(() => {
    const element = node.current;
    if (element === null) return undefined;
    const measure = (): void => setPerPage(Math.max(1, Math.floor((element.clientWidth - 8) / TOUCH_TARGET_PX)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [perPage, ref];
}

/**
 * The key pill's pages (#2778), as the Herdr app's phone row draws them: as many keys as fit a page, a swipe moving a
 * whole page, and a dot per page under them with the page in view filled. The scroller keeps the slot name the keys always
 * had, so a key is found the same way as before.
 */
export function KeyPages({ items, onScroll }: KeyPagesProps) {
  const [perPage, ref] = usePerPage();
  const pages = pagesOf(items, perPage);
  const [scrolledTo, setPage] = useState(1);
  // Wider pages are fewer pages: until the next scroll the page last scrolled to can lie past the last one.
  const page = Math.min(scrolledTo, pages.length);
  const follow = (element: HTMLDivElement): void => {
    const width = element.clientWidth;
    if (width > 0) setPage(Math.min(pages.length, Math.round(element.scrollLeft / width) + 1));
    onScroll?.(element.scrollLeft);
  };
  return (
    <>
      <div
        ref={ref}
        data-slot="terminal-keys-scroll"
        data-pages={pages.length}
        data-page={page}
        onScroll={(event) => follow(event.currentTarget)}
        className="flex h-11 w-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {pages.map((keys, index) => (
          // A page is a position, not an identity: keys move between pages as the list or the width changes.
          <div
            key={`page-${index}`}
            data-slot="key-page"
            className="flex w-full shrink-0 snap-start items-center justify-around px-1"
          >
            {keys}
          </div>
        ))}
      </div>
      {pages.length < 2 ? null : (
        <span aria-hidden className="pointer-events-none absolute bottom-1 left-1/2 flex -translate-x-1/2 gap-1">
          {pages.map((_, index) => (
            <span
              key={`dot-${index}`}
              data-slot="page-dot"
              className={cn("size-1 rounded-full", index + 1 === page ? "bg-foreground" : "bg-muted-foreground/50")}
            />
          ))}
        </span>
      )}
    </>
  );
}
