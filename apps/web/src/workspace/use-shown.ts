import type { Terminal } from "@doriface/protocol";
import { createContext, use, useRef, useSyncExternalStore } from "react";
import type { LiveTerminals } from "../roster/live-terminals.ts";
import { programKind, terminalTitle } from "./model.ts";

/** The workspace's terminals as they stand now; absent outside a workspace, where a list is shown as given. */
export const LiveTerminalsContext = createContext<LiveTerminals | null>(null);

/** What a close question reads of a session: its name, and whether a program runs in front of its shell. */
export const titleAndProgram = (terminal: Terminal): string => `${terminalTitle(terminal)}\n${programKind(terminal)}`;

const nothing = (): (() => void) => () => undefined;

interface Shown<T> {
  readonly sessions: readonly T[];
  readonly keys: readonly string[];
  readonly shown: readonly T[];
}

/** A session with the title and foreground its terminal has now; the workspace's list keeps them as of its last shape. */
function asItStands<T extends Terminal>(session: T, now: Terminal | undefined): T {
  if (now === undefined || now === session) return session;
  if (now.title === session.title && now.foreground === session.foreground) return session;
  return Object.assign({}, session, { title: now.title, foreground: now.foreground });
}

/**
 * These sessions as they show now, for a surface that names them: it renders again only when what `shows` reads of one
 * of them changes, never for another terminal's output or for what it does not show (#2607).
 */
export function useShown<T extends Terminal>(
  sessions: readonly T[],
  shows: (terminal: Terminal) => string = terminalTitle,
): readonly T[] {
  const live = use(LiveTerminalsContext);
  const last = useRef<Shown<T> | null>(null);
  const read = (): readonly T[] => {
    if (live === null) return sessions;
    const now = sessions.map((session) => asItStands(session, live.get(session.address)));
    const keys = now.map(shows);
    const held = last.current;
    if (
      held !== null &&
      held.sessions.length === sessions.length &&
      held.sessions.every((session, index) => session === sessions[index] && held.keys[index] === keys[index])
    ) {
      return held.shown;
    }
    last.current = { sessions, keys, shown: now };
    return now;
  };
  return useSyncExternalStore(live?.subscribe ?? nothing, read);
}
