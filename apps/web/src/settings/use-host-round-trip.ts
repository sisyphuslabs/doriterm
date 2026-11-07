import type { HcConnection } from "@doriface/client";
import { useEffect, useState } from "react";
import { measureRoundTrip } from "./round-trip.ts";

/** How often the round trip is measured again: often enough to be current, rare enough to cost nothing. */
const EVERY_MS = 15_000;

/**
 * A measured round trip, never a guess and never a stale one: a failed call reports no number rather than the last one.
 */
export function useHostRoundTrip(connection: HcConnection | null): number | undefined {
  const [ms, setMs] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (connection === null) return setMs(undefined);
    let cancelled = false;
    const measure = async (): Promise<void> => {
      const measured = await measureRoundTrip(connection);
      if (!cancelled) setMs(measured);
    };
    void measure();
    const timer = setInterval(() => void measure(), EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection]);
  return ms;
}
