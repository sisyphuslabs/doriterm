import type { HcConnection } from "@doriface/client";
import type { ListResult, Terminal } from "@doriface/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyEvent, fromSnapshot, type TerminalMap } from "./terminals.ts";

export interface TerminalsState {
  readonly terminals: readonly Terminal[];
  /** False until the core's first answer: an empty list before it means unknown, not none. */
  readonly loaded: boolean;
  readonly machines: number;
  readonly error: string | null;
}

/** hc 0.1.17 leaves machines out of terminal.list answers when it has none, so absent counts as none. */
export function machineCount(list: Pick<ListResult, "machines">): number {
  return list.machines?.length ?? 0;
}

const EMPTY: TerminalsState = { terminals: [], loaded: false, machines: 0, error: null };

/**
 * What each connection last showed. While the page reconnects, the workspace stays on the connection that dropped, and
 * one that mounts again then (Settings and back) starts from this: that connection can no longer answer, so without it
 * the list stayed empty and every pane waited until a reconnect landed (#403).
 */
const lastShown = new WeakMap<HcConnection, TerminalsState>();

/** A core document changed: which machine's (null for this core's), its name and its new version. */
export type DocHeard = (machine: string | null, name: string, version: number) => void;

/**
 * terminal.list for the first picture and machine count, then events.subscribe keeps it live. The same feed carries
 * `doc` events, handed to `onDoc`.
 */
export function useTerminals(
  connection: HcConnection | null,
  onDoc?: DocHeard,
): TerminalsState & { readonly retry: () => void } {
  const [state, setState] = useState<TerminalsState>(() =>
    connection === null ? EMPTY : (lastShown.get(connection) ?? EMPTY),
  );
  // Asks the core again: a first answer that failed says so with Try again instead of loading forever (#819).
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const docHeard = useRef(onDoc);
  docHeard.current = onDoc;

  useEffect(() => {
    if (connection === null) {
      setState(EMPTY);
      return undefined;
    }
    // A connection that already dropped has nothing new to say: keep what it last showed until the next one answers.
    if (connection.closed) return undefined;
    setState((prev) => (prev.error === null ? prev : { ...prev, error: null }));
    let map: TerminalMap = new Map();
    let machines = 0;
    let disposed = false;
    const publish = (): void => {
      if (disposed) return;
      const shown: TerminalsState = { terminals: [...map.values()], loaded: true, machines, error: null };
      lastShown.set(connection, shown);
      setState(shown);
    };
    const fail = (cause: unknown): void => {
      if (!disposed) setState((prev) => ({ ...prev, error: String(cause) }));
    };
    // Finished terminals too, as the feed's snapshot lists them: an ended terminal that dropped out of the first picture
    // and came back with the snapshot would remount its view, which then no longer knows the page had it open (#164).
    connection.call("terminal.list", { all: true }).then((list) => {
      machines = machineCount(list);
      if (map.size === 0) map = new Map(list.terminals.map((terminal) => [terminal.address, terminal]));
      publish();
      return list;
    }, fail);
    const feed = connection.subscribe();
    feed.then((subscribed) => {
      if (disposed) {
        subscribed.close();
        return subscribed;
      }
      map = fromSnapshot(subscribed.snapshot);
      publish();
      subscribed.onSnapshot((snapshot) => {
        map = fromSnapshot(snapshot);
        publish();
      });
      subscribed.onEvent((event) => {
        if (event.type === "doc") docHeard.current?.(event.machine ?? null, event.data.name, event.data.version);
        const next = applyEvent(map, event);
        if (next === map) return;
        map = next;
        publish();
      });
      return subscribed;
    }, fail);
    return () => {
      disposed = true;
      void feed.then(
        (subscribed) => subscribed.close(),
        () => undefined,
      );
    };
  }, [connection, attempt]);

  return { ...state, retry };
}
