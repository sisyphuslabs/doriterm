import type { HcConnection } from "@doriface/client";
import { useEffect, useState } from "react";
import { measureRoundTrip } from "./round-trip.ts";

/** How often the round trip is measured again: often enough to be current, rare enough to cost nothing. */
const EVERY_MS = 15_000;

/**
 * A measured round trip, never a guess and never a stale one: a failed call reports no number rather than the last one.
 */
export function useHostRoundTrip(connection: HcConnection | null): number | undefined {
  const [sample, setSample] = useState<{
    readonly connection: HcConnection;
    readonly ms: number | undefined;
  }>();
  useEffect(() => {
    if (connection === null) {
      // A session that pauses keeps its connection object; what was measured before the pause is not shown again.
      setSample(undefined);
      return;
    }
    let cancelled = false;
    const measure = async (): Promise<void> => {
      const measured = await measureRoundTrip(connection);
      if (!cancelled) setSample({ connection, ms: measured });
    };
    void measure();
    const timer = setInterval(() => void measure(), EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection]);
  return sample?.connection === connection ? sample?.ms : undefined;
}
