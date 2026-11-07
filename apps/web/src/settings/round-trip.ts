import type { HcConnection } from "@doriface/client";

/**
 * One round trip on the live connection, timed on this device: a call the host's core answers at once. A failed call is
 * no number rather than the last one, so the row never shows a stale or guessed figure (#787).
 */
export async function measureRoundTrip(
  connection: Pick<HcConnection, "call">,
  now: () => number = () => performance.now(),
): Promise<number | undefined> {
  const started = now();
  try {
    await connection.call("machine.list");
  } catch {
    return undefined;
  }
  return Math.max(1, Math.round(now() - started));
}

export interface LinkFact {
  readonly kind: "connect" | "round-trip";
  readonly ms: number;
}

/** The session's measured facts in the order the host row reads them; a fact not measured is left out, never 0 ms. */
export function linkFacts(connectMs: number | undefined, roundTripMs: number | undefined): readonly LinkFact[] {
  const facts: LinkFact[] = [];
  if (connectMs !== undefined) facts.push({ kind: "connect", ms: Math.max(1, Math.round(connectMs)) });
  if (roundTripMs !== undefined) facts.push({ kind: "round-trip", ms: roundTripMs });
  return facts;
}
