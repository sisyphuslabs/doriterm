import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal } from "@doriface/protocol";
import { useEffect, useRef } from "react";
import { type PendingEnd, type PendingEnds, resumeOf, routedPendingEnds } from "./pending-ends.ts";
import { endSession, isGone, sessionCalls, type SessionCalls } from "./session-actions.ts";

/**
 * Sees through the Ends a closed page left unfinished: one whose calls never left that page ends its program now, one
 * whose program ended is removed, and one about a program that is gone or replaced is dropped. An End that fails here
 * stays pending for the next connection.
 */
export async function resumeEnds(
  ends: PendingEnds,
  get: (address: string) => Promise<Pick<Terminal, "state" | "pid" | "created_ms">>,
  calls: SessionCalls,
  stillWanted: () => boolean = () => true,
): Promise<void> {
  const resume = async (end: PendingEnd): Promise<void> => {
    try {
      const step = resumeOf(end, await get(end.address));
      if (step === "end") await endSession(calls, end.address);
      else if (step === "remove") await calls.rm({ terminal: end.address });
      ends.remove(end.address, end);
    } catch (cause) {
      if (isGone(cause)) ends.remove(end.address, end);
      else console.error(`finish the End of ${end.address} later: ${String(cause)}`);
    }
  };
  // One session at a time, each read from the core just before it is acted on.
  await ends.list().reduce<Promise<void>>(async (previous, end) => {
    await previous;
    if (stillWanted()) await resume(end);
  }, Promise.resolve());
}

/**
 * Ends a session with its End kept in `ends` until it settles, so a page closed before End's calls leave it has the
 * next page finish it. Settled either way, the record goes: after "The session did not end" the session is the
 * person's to keep or end again, never a later page's.
 */
export function recordedEnd(ends: PendingEnds, end: PendingEnd, calls: SessionCalls): Promise<void> {
  ends.add(end);
  return endSession(calls, end.address).finally(() => ends.remove(end.address, end));
}

/**
 * Once per connection, finishes the Ends this browser asked of its core, or of a machine it reaches, that a closed page
 * left unfinished. It waits for the first machine list (`machines` undefined until then), so an End kept with an added
 * machine's core is found by that machine's address on this route (#2288). If that first list failed, it runs once with
 * the connected core alone: an added machine's Ends stay kept and are finished on the next connection.
 */
export function useResumeEnds(connection: HcConnection, machines: readonly MachineView[] | undefined): void {
  const listed = machines !== undefined;
  const route = useRef(machines);
  route.current = machines;
  useEffect(() => {
    if (!listed) return undefined;
    let current = true;
    void resumeEnds(
      routedPendingEnds({ core: connection.hello.core.id, machines: route.current ?? [] }),
      (address) => connection.call("terminal.get", { terminal: address }),
      sessionCalls(connection),
      () => current && !connection.closed,
    );
    return () => {
      current = false;
    };
  }, [connection, listed]);
}
