import type { Terminal } from "@doriface/protocol";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { killWentThrough } from "./session-actions.ts";

type Listed = Pick<Terminal, "address" | "state" | "pid" | "created_ms">;

interface Dropped {
  /** The session listed live at the address when its pane was dropped (pid and start), null when none was. */
  readonly session: string | null;
  /** Whether a list has shown the address not live since the drop. */
  readonly ended: boolean;
}

/** One session, as resumeOf tells a replaced one apart: its program's pid and the terminal's start. */
const sessionOf = (terminal: Listed): string => `${terminal.pid ?? "none"}@${terminal.created_ms}`;

/**
 * Which ended sessions already had their pane dropped. A session is dropped once, by whichever automatic signal comes
 * first: closing it ends and removes it (#409), so its view's end and the dead-pane check both report it, and a refused
 * drop keeps the pane, so a second drop would be refused again, toast again and move the view.
 *
 * A list that has not heard the end yet (the feed behind, or a machine.list read rebuilding the same feed) still shows
 * the dropped session live; that is the same session, not a new one (#1328). The address takes a new drop only once a
 * list shows a new session in it: live after it was listed not live, or another program (pid or start) live there.
 */
export class DropOnce {
  readonly #dropped = new Map<string, Dropped>();
  #live: ReadonlyMap<string, Listed> = new Map();

  /** Whether the latest End at an address killed its program (killWentThrough), read by kept. */
  readonly #killed: (address: string) => boolean;

  constructor(killed: (address: string) => boolean = killWentThrough) {
    this.#killed = killed;
  }

  /** True the first time the session at `address` is dropped, false for every later report of the same session. */
  take(address: string): boolean {
    if (this.#dropped.has(address)) return false;
    const live = this.#live.get(address);
    this.#dropped.set(address, { session: live === undefined ? null : sessionOf(live), ended: live === undefined });
    return true;
  }

  /** Whether this device dropped the session at `address` (take), as opposed to another device's write taking its pane. */
  dropped(address: string): boolean {
    return this.#dropped.has(address);
  }

  /**
   * A close dropped this session's pane, but its End failed: the session keeps running, and its later end drops again.
   * End also fails after a kill that worked (terminal.rm or the END label refused, #1342): that session has ended, so it
   * keeps its mark whether or not a list has shown the end yet, and its end is not dropped a second time.
   */
  kept(address: string): void {
    if (this.#dropped.get(address)?.ended === true || this.#killed(address)) return;
    this.#dropped.delete(address);
  }

  /** What the page lists now: a dropped address listed with a new session in it is dropped again when that one ends. */
  listed(terminals: readonly Listed[]): void {
    this.#live = new Map(
      terminals.flatMap((terminal) => (terminal.state === "live" ? [[terminal.address, terminal]] : [])),
    );
    for (const [address, dropped] of this.#dropped) {
      const live = this.#live.get(address);
      if (live === undefined) this.#dropped.set(address, { ...dropped, ended: true });
      else if (dropped.ended || sessionOf(live) !== dropped.session) this.#dropped.delete(address);
    }
  }
}

export interface DropsOnce {
  /** `drop`, called at most once per ended session however many signals report its end (see DropOnce). */
  readonly dropEnded: (address: string) => void;
  /** Records these sessions as dropped by a close that writes their panes' removal itself (a whole tab). */
  readonly closing: (addresses: readonly string[]) => void;
  /** A close's End failed and this session keeps running: its later end drops its pane again (DropOnce.kept). */
  readonly kept: (address: string) => void;
  /** Whether this device dropped the session's pane itself (DropOnce.dropped). */
  readonly dropped: (address: string) => boolean;
}

/**
 * A close writes its pane's removal as it is chosen and then ends the session, whose end reports it again: that report
 * is the same drop, so with the close's write refused it would be written, refused and said a second time (#1328).
 */
export function useDropOnce(terminals: readonly Listed[], drop: (address: string) => void): DropsOnce {
  const once = useRef(new DropOnce());
  useEffect(() => once.current.listed(terminals), [terminals]);
  const dropEnded = useCallback(
    (address: string): void => {
      if (once.current.take(address)) drop(address);
    },
    [drop],
  );
  const closing = useCallback((addresses: readonly string[]): void => {
    for (const address of addresses) once.current.take(address);
  }, []);
  const kept = useCallback((address: string): void => once.current.kept(address), []);
  const dropped = useCallback((address: string): boolean => once.current.dropped(address), []);
  return useMemo(() => ({ dropEnded, closing, kept, dropped }), [dropEnded, closing, kept, dropped]);
}
