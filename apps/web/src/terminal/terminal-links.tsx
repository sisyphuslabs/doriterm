import { MenuCaption, MenuItem, PointMenu } from "@doriface/ui";
import type { WTerm } from "@wterm/react";
import { Copy, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openTerminalLink } from "../desktop/bridge.ts";
import { isBrowsing } from "./browse-mode.ts";
import { type CellAt, type CellSource, linkAt, showsOtherTarget, type TerminalLink } from "./links.ts";

/** The key that makes a click open a link, as in Ghostty: Cmd on a Mac, Ctrl elsewhere. */
const opensLinks = (event: MouseEvent | KeyboardEvent): boolean =>
  navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;

/** The cell under a point, from the grid's own geometry: rows above the grid are the scrollback, row 0 the oldest kept. */
function cellAt(wt: WTerm, x: number, y: number): CellAt | null {
  const bridge = wt.bridge;
  const grid = wt.element.querySelector<HTMLElement>(".term-row:not(.term-scrollback-row)");
  if (bridge === null || grid === null) return null;
  const box = grid.getBoundingClientRect();
  const cellWidth = parseFloat(getComputedStyle(wt.element).getPropertyValue("--term-cell-width")) || 0;
  if (cellWidth <= 0 || box.height <= 0) return null;
  const col = Math.floor((x - box.left) / cellWidth);
  if (col < 0 || col >= wt.cols) return null;
  const row = bridge.getScrollbackCount() + Math.floor((y - box.top) / box.height);
  return { row, col };
}

/** The link under a point, or null; a pointer on the second half of a wide glyph reads the glyph's own cell. */
function linkUnder(wt: WTerm, x: number, y: number): TerminalLink | null {
  const bridge = wt.bridge;
  const at = cellAt(wt, x, y);
  if (bridge === null || at === null) return null;
  const core: CellSource = bridge;
  return linkAt(core, at) ?? (at.col > 0 ? linkAt(core, { row: at.row, col: at.col - 1 }) : null);
}

/** Where each run of a link is drawn, relative to the terminal's wrapper, to underline it. */
function underlines(wt: WTerm, link: TerminalLink): { left: number; top: number; width: number }[] {
  const bridge = wt.bridge;
  const grid = wt.element.querySelector<HTMLElement>(".term-row:not(.term-scrollback-row)");
  const wrapper = wt.element.parentElement;
  if (bridge === null || grid === null || wrapper === null) return [];
  const box = grid.getBoundingClientRect();
  const origin = wrapper.getBoundingClientRect();
  const cellWidth = parseFloat(getComputedStyle(wt.element).getPropertyValue("--term-cell-width")) || 0;
  const history = bridge.getScrollbackCount();
  return link.runs.map((run) => ({
    left: box.left - origin.left + run.start * cellWidth,
    top: box.top - origin.top + (run.row - history + 1) * box.height - 2,
    width: (run.end - run.start) * cellWidth,
  }));
}

interface Hover {
  readonly link: TerminalLink;
  readonly lines: readonly { readonly left: number; readonly top: number; readonly width: number }[];
}

interface Offer {
  readonly link: TerminalLink;
  readonly x: number;
  readonly y: number;
}

/**
 * Terminal links (#296), detected on this device from the cells, so they work the same over the relay as on
 * loopback. Holding Cmd (Ctrl elsewhere) underlines the link under the pointer, and a click with it opens the link in a
 * new tab (the system browser in the desktop app). A tap on a link on a touch screen offers Open and Copy. A link
 * whose text is not its target, or one whose scheme may not open, shows its real target in that menu instead of
 * opening. Plain clicks, selection and mouse reporting to the program are untouched.
 */
export function TerminalLinks({ wt }: { readonly wt: WTerm }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const pointer = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  // A tap ends with pointerleave before its click, so whether the press was a touch is kept apart from the hover.
  const pressedByTouch = useRef(false);

  useEffect(() => {
    const element = wt.element;
    const show = (held: boolean): void => {
      const at = pointer.current;
      const link = held && at !== null && !at.touch ? linkUnder(wt, at.x, at.y) : null;
      element.classList.toggle("term-link-hover", link !== null);
      setHover(link === null ? null : { link, lines: underlines(wt, link) });
    };
    const open = (link: TerminalLink, x: number, y: number): void => {
      if (link.href !== null && !showsOtherTarget(link)) openTerminalLink(link.href);
      else setOffer({ link, x, y });
    };
    const onMove = (event: PointerEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === "touch" };
      show(opensLinks(event));
    };
    const onKey = (event: KeyboardEvent): void => show(opensLinks(event));
    const onLeave = (): void => {
      pointer.current = null;
      show(false);
    };
    // A press that opens a link starts no selection and reaches neither the program nor wterm's own link handling.
    const onDown = (event: MouseEvent): void => {
      if (event.button !== 0 || !opensLinks(event) || linkUnder(wt, event.clientX, event.clientY) === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onClick = (event: MouseEvent): void => {
      const touch = pressedByTouch.current;
      if (!touch && !opensLinks(event)) return;
      const link = linkUnder(wt, event.clientX, event.clientY);
      if (link === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (touch) setOffer({ link, x: event.clientX, y: event.clientY });
      else open(link, event.clientX, event.clientY);
    };
    const onPointerDown = (event: PointerEvent): void => {
      pressedByTouch.current = event.pointerType === "touch";
      pointer.current = { x: event.clientX, y: event.clientY, touch: pressedByTouch.current };
    };
    const onScroll = (): void => show(false);
    // wterm draws an OSC 8 http(s) link as an anchor: a middle click would open it with no look at its real target.
    const onAux = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest(".term-link") !== null) event.preventDefault();
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerdown", onPointerDown, { capture: true });
    element.addEventListener("pointerleave", onLeave);
    element.addEventListener("mousedown", onDown, { capture: true });
    element.addEventListener("click", onClick, { capture: true });
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("auxclick", onAux, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerdown", onPointerDown, { capture: true });
      element.removeEventListener("pointerleave", onLeave);
      element.removeEventListener("mousedown", onDown, { capture: true });
      element.removeEventListener("click", onClick, { capture: true });
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("auxclick", onAux, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      element.classList.remove("term-link-hover");
    };
  }, [wt]);

  const link = offer?.link;
  const close = (): void => {
    setOffer(null);
    // A terminal browsed read-only keeps its keyboard away; a tap on a link there is still a read.
    if (!isBrowsing(wt.element)) wt.focus();
  };
  return (
    <>
      {hover === null
        ? null
        : hover.lines.map((line) => (
            <span
              key={`${line.left}:${line.top}`}
              aria-hidden
              data-link-underline
              className="pointer-events-none absolute h-px bg-current text-foreground"
              style={{ left: line.left, top: line.top, width: line.width }}
            />
          ))}
      {hover !== null && showsOtherTarget(hover.link) && hover.lines[0] !== undefined ? (
        <span
          role="tooltip"
          data-link-target
          className="pointer-events-none absolute z-20 max-w-[min(32rem,90%)] truncate rounded-md border border-border bg-popover px-2 py-1 font-mono text-xs text-popover-foreground shadow-overlay"
          style={{ left: hover.lines[0].left, top: hover.lines[0].top + 6 }}
        >
          {hover.link.target}
        </span>
      ) : null}
      <PointMenu at={offer === null ? null : { x: offer.x, y: offer.y }} onClose={close} label="Link">
        {link === undefined ? null : (
          <>
            <MenuCaption>{link.href === null ? `Does not open: ${link.target}` : link.target}</MenuCaption>
            <MenuItem
              icon={<ExternalLink aria-hidden />}
              disabled={link.href === null}
              onClick={() => {
                if (link.href !== null) openTerminalLink(link.href);
                close();
              }}
            >
              Open link
            </MenuItem>
            <MenuItem
              icon={<Copy aria-hidden />}
              onClick={() => {
                void navigator.clipboard?.writeText(link.target).catch(() => undefined);
                close();
              }}
            >
              Copy link
            </MenuItem>
          </>
        )}
      </PointMenu>
    </>
  );
}
