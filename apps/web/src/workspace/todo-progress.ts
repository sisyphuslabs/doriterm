import type { HcConnection } from "@doriface/client";
import { readTodoProgress, readsTodos, type TodoProgress } from "@doriface/protocol";
import { createContext, use, useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "./model.ts";

/** A terminal's agent todo list, when its agent draws one this reads. */
export type TodoOf = (address: string) => TodoProgress | undefined;

export const TodoProgressContext = createContext<TodoOf>(() => undefined);

export const useTodoOf = (): TodoOf => use(TodoProgressContext);

/**
 * When a terminal's list is worth reading again: its agent reported something new. Claude Code reports progress with
 * every task it updates, so a status change is when the list on its screen changes. Undefined for a terminal whose agent
 * draws no list this reads, or that is not live.
 */
export function todoReadKey(terminal: Session): string | undefined {
  const app = terminal.status?.app ?? "";
  if (terminal.state !== "live" || terminal.offline === true || !readsTodos(app)) return undefined;
  const { state, progress, msg } = terminal.status ?? { state: "" };
  return [app, state, progress ?? "", msg ?? "", terminal.status_ms ?? "", terminal.turn ?? ""].join("\u0000");
}

/**
 * A blocked agent waits on a dialog the approval card reads; nothing moves its list until it is answered. Its row keeps
 * the progress it had, and its screen is not read, so the card's own reads are the only ones while it waits.
 */
export const holdsTodoRead = (terminal: Session): boolean => terminal.status?.state === "blocked";

/** The status can land before the agent draws: a first read soon after it, and a second once the draw has settled. */
const READ_WAITS_MS = [150, 1000];

/** Equal lists for the same terminals: the same map, so the rows do not draw again. */
function sameProgress(a: ReadonlyMap<string, TodoProgress>, b: ReadonlyMap<string, TodoProgress>): boolean {
  if (a.size !== b.size) return false;
  for (const [address, one] of a) {
    const other = b.get(address);
    if (other === undefined || other.done !== one.done || other.total !== one.total) return false;
  }
  return true;
}

/**
 * Each agent's todo progress, read from its live screen (`terminal.read`, the visible lines only) when its status
 * changes. A read that finds no list clears the terminal's progress, and a read overtaken by a newer status is dropped.
 */
export function useTodoProgress(connection: HcConnection, terminals: readonly Session[]): TodoOf {
  const [progress, setProgress] = useState<ReadonlyMap<string, TodoProgress>>(() => new Map());
  const signature = terminals
    .flatMap((terminal) => {
      const key = todoReadKey(terminal);
      if (key === undefined) return [];
      const hold = holdsTodoRead(terminal) ? "hold" : "";
      return [`${terminal.address}\u0001${terminal.status?.app ?? ""}\u0001${key}\u0001${hold}`];
    })
    .join("\n");
  const keys = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());

  useEffect(() => {
    const wanted = new Map<string, { readonly app: string; readonly key: string; readonly hold: boolean }>();
    for (const line of signature === "" ? [] : signature.split("\n")) {
      const [address = "", app = "", key = "", hold = ""] = line.split("\u0001");
      wanted.set(address, { app, key, hold: hold !== "" });
    }
    // A copy: the loop deletes from the map it walks.
    for (const address of Array.from(keys.current.keys())) {
      if (wanted.has(address)) continue;
      keys.current.delete(address);
      for (const timer of timers.current.get(address) ?? []) clearTimeout(timer);
      timers.current.delete(address);
    }
    setProgress((before) => {
      const kept = new Map([...before].filter(([address]) => wanted.has(address)));
      return kept.size === before.size ? before : kept;
    });
    for (const [address, { app, key, hold }] of wanted) {
      if (keys.current.get(address) === key) continue;
      keys.current.set(address, key);
      for (const timer of timers.current.get(address) ?? []) clearTimeout(timer);
      timers.current.delete(address);
      if (hold) continue;
      const read = async (): Promise<void> => {
        let found: TodoProgress | undefined;
        try {
          const screen = await connection.call("terminal.read", { terminal: address, lines: 0 });
          found = readTodoProgress(app, screen.text);
        } catch {
          // A read that fails (a dropped link, a terminal that just ended) leaves the row as it was.
          return;
        }
        if (keys.current.get(address) !== key) return;
        setProgress((before) => {
          const next = new Map(before);
          if (found === undefined) next.delete(address);
          else next.set(address, found);
          return sameProgress(before, next) ? before : next;
        });
      };
      timers.current.set(
        address,
        READ_WAITS_MS.map((wait) => setTimeout(() => void read(), wait)),
      );
    }
  }, [connection, signature]);

  useEffect(
    () => () => {
      for (const list of timers.current.values()) for (const timer of list) clearTimeout(timer);
      timers.current.clear();
      keys.current.clear();
    },
    [],
  );

  // One getter per progress map, so the context and the agents memo keyed on it change only when progress does (#910).
  return useCallback((address) => progress.get(address), [progress]);
}
