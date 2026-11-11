import type { ConnectionPath } from "../connection/connect.ts";
import type { DirectReason } from "../connection/direct-attempt.ts";
import { directPathAvailable } from "../connection/direct-switch.ts";

/** Each reason a direct attempt can fail, in the words that say what happened; every variant is named so none falls back. */
const REASONS: Readonly<Record<DirectReason, string>> = {
  blocked: "This page may not open a direct link, so the relay carries it.",
  "unusable-address": "The saved direct address is not usable, so the relay carries it.",
  "no-answer": "The direct link did not answer, so the relay carries it.",
  "could-not-connect": "The direct link could not be opened, so the relay carries it.",
  "authentication-failed": "The direct link failed its security check, so the relay carries it.",
};

/**
 * The session as it is actually carried, not the route as configured: the connection line says what is set up, and only
 * this says what happened (#768).
 *
 * Only the desktop shell with the direct path switched on can have run a direct attempt (#1381 §8, #2070), so only it
 * names a direct path or a reason direct did not carry the session; every other session is the relay's, whatever an
 * older settings file holds.
 */
export function sessionPathLabel(
  path: ConnectionPath,
  directReason?: DirectReason,
  directPath: boolean = directPathAvailable(),
): string {
  if (!directPath) return path === "loopback" ? "On this computer" : "Through the relay";
  switch (path) {
    case "direct":
      return "Direct to this host on this network";
    case "loopback":
      return "On this computer";
    case "relay":
      return directReason === undefined ? "Through the relay" : REASONS[directReason];
  }
}
