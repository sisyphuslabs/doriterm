import type { OpenConnection } from "./connect.ts";
import { SessionResumer } from "./session-resume.ts";
import type { UnprovenLinks } from "./wake.ts";

export interface ResumeWiringHooks {
  /** The store's open state says the session is being carried on (true) or is carried on or given up (false). */
  readonly resuming: (on: boolean) => void;
  /** Where the connection is listed while its session is being carried on, so typed input waits (#1370). */
  readonly links: UnprovenLinks;
  /** A dial to carry the session on failed and another follows. */
  readonly failed?: ((error: Error) => void) | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

/** A connection's session resume, as the store drives it: starts on a detach, is kicked by a wake, stops with the connection. */
export interface ResumeWiring {
  readonly resumer: SessionResumer;
  /** The link under the connection is gone or silent: true when the session took the loss and is being carried on. */
  readonly lost: (reason: Error) => boolean;
  readonly stop: () => void;
}

/**
 * Lets a connection's session outlive its socket (contract v1.11): the session is allowed to detach, and each detach
 * starts the resumer. Null for a connection with no session (the loopback path).
 */
export function wireResume(opened: OpenConnection, hooks: ResumeWiringHooks): ResumeWiring | null {
  const { session, connection } = opened;
  if (session === undefined) return null;
  const resumer = new SessionResumer(session, {
    resuming: (on) => {
      if (on) hooks.links.start(connection);
      hooks.resuming(on);
      // Carried on: what waited is written to the same stream. Given up: the connection is dropping, and what waited goes
      // to the next one's stream.
      if (!on) hooks.links.settle(connection, !session.secure.closed);
    },
    failed: hooks.failed,
    log: hooks.log,
  });
  session.secure.allowResume();
  const unsubscribe = session.secure.onDetached((reason) => resumer.start(reason));
  return {
    resumer,
    lost: (reason) => session.secure.lost(reason),
    stop: () => {
      unsubscribe();
      resumer.stop();
    },
  };
}
