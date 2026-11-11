import type { Terminal } from "@doriface/protocol";
import { guardedLocalStorage, type StorageLike } from "../storage/guarded.ts";
import { addressOf, identityOf, type TerminalRoute } from "./terminal-identity.ts";

/**
 * An End the user confirmed that this browser has not seen through yet. The address alone is not the terminal: an added
 * machine's name can come to name another machine, so the record also keeps the program's pid and hc's creation time of
 * the terminal, and acts only where both still match.
 */
export interface PendingEnd {
  readonly address: string;
  readonly pid: number | null;
  /** The terminal's `created_ms`. */
  readonly created: number;
  /** When it was asked, in ms since the epoch. */
  readonly at: number;
}

/** A confirmed End older than this is not resumed: the session may have been reused long since. */
export const PENDING_END_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The Ends of one core this browser asked and has not seen settle, kept in local storage across page loads. */
export interface PendingEnds {
  add(end: PendingEnd): void;
  /** Drops the record at `address`; given `end`, only one about that same terminal (its pid and creation time). */
  remove(address: string, end?: Pick<PendingEnd, "pid" | "created">): void;
  /** Whether an End is kept for this address, whatever its age. */
  has(address: string): boolean;
  /** The ones still young enough to resume, oldest first. */
  list(now?: number): readonly PendingEnd[];
}

const keyOf = (core: string): string => `doriface.pending-ends.v1.${core}`;

const isPendingEnd = (value: unknown): value is PendingEnd =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "address") === "string" &&
  typeof Reflect.get(value, "at") === "number" &&
  typeof Reflect.get(value, "created") === "number" &&
  (Reflect.get(value, "pid") === null || typeof Reflect.get(value, "pid") === "number");

/** Reads `core`'s pending Ends from `storage`; a store that cannot be read or written keeps nothing (a private window). */
export function pendingEnds(core: string, storage: StorageLike | undefined = guardedLocalStorage()): PendingEnds {
  const read = (): PendingEnd[] => {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(keyOf(core)) ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(isPendingEnd) : [];
    } catch {
      return [];
    }
  };
  const write = (ends: readonly PendingEnd[]): void => {
    try {
      if (ends.length === 0) storage?.removeItem(keyOf(core));
      else storage?.setItem(keyOf(core), JSON.stringify(ends));
    } catch {
      // A full or refused store: the End still runs on this page, it only cannot outlive a page close.
    }
  };
  return {
    add: (end) => write([...read().filter((entry) => entry.address !== end.address), end]),
    remove: (address, end) =>
      write(
        read().filter(
          (entry) =>
            entry.address !== address ||
            (end !== undefined && (entry.pid !== end.pid || entry.created !== end.created)),
        ),
      ),
    has: (address) => read().some((entry) => entry.address === address),
    list: (now = Date.now()) =>
      read()
        .filter((entry) => now - entry.at <= PENDING_END_MAX_AGE_MS)
        .toSorted((a, b) => a.at - b.at),
  };
}

/**
 * The pending Ends of every core `route` reaches, by the address each terminal has on this route (#2288). An End is kept
 * with the core that runs its terminal, by that core's own terminal id, so one asked through another machine resumes
 * when the page reaches that core directly, and the other way round. A record from before this (an address with a
 * machine prefix, kept with the core it was asked through) is still acted on there, as written.
 */
export function routedPendingEnds(
  route: TerminalRoute,
  storage: StorageLike | undefined = guardedLocalStorage(),
): PendingEnds {
  const own = (core: string): PendingEnds => pendingEnds(core, storage);
  return {
    // A record this route's address already had in the old place is taken over here, so one terminal never has two.
    add: (end) => {
      const identity = identityOf(end.address, route);
      if (identity === undefined) return own(route.core).add(end);
      if (end.address.includes("/")) own(route.core).remove(end.address);
      own(identity.core).add({ ...end, address: identity.terminal });
    },
    // Given the End it settles, it drops that terminal's record wherever it is kept (an older tab may have written one
    // the old way meanwhile) and nothing else: a renamed machine's record for its own terminal of that id stays.
    remove: (address, end) => {
      if (address.includes("/")) own(route.core).remove(address, end);
      const identity = identityOf(address, route);
      if (identity !== undefined) own(identity.core).remove(identity.terminal, end);
    },
    has: (address) => {
      const identity = identityOf(address, route);
      return (
        (address.includes("/") && own(route.core).has(address)) ||
        (identity !== undefined && own(identity.core).has(identity.terminal))
      );
    },
    list: (now) =>
      [route.core, ...route.machines.map((machine) => machine.id)]
        .flatMap((core) =>
          own(core)
            .list(now)
            .flatMap((end) => {
              const address = end.address.includes("/")
                ? core === route.core
                  ? end.address
                  : undefined
                : addressOf({ core, terminal: end.address }, route);
              return address === undefined ? [] : [{ ...end, address }];
            }),
        )
        .toSorted((a, b) => a.at - b.at),
  };
}

/**
 * What to do with a pending End once the core says what it holds at that address:
 * - `end`: the very terminal it was asked about still runs its program; end it again.
 * - `remove`: that terminal's program ended, but the terminal was not removed; remove it.
 * - `drop`: anything else: the terminal is gone, another terminal or program is there now, or the record cannot say
 *   which program it was about. A pending End never acts on a terminal it cannot prove is the one asked about.
 */
export type Resume = "end" | "remove" | "drop";

export function resumeOf(end: PendingEnd, terminal: Pick<Terminal, "state" | "pid" | "created_ms"> | null): Resume {
  if (terminal === null || end.pid === null) return "drop";
  if (terminal.pid !== end.pid || terminal.created_ms !== end.created) return "drop";
  return terminal.state === "live" ? "end" : "remove";
}
