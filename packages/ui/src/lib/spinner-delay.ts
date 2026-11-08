import { useEffect, useState } from "react";

/** How long a wait may stay unremarked before it earns a spinner: shorter waits never flash one (Apple HIG). */
export const SPINNER_DELAY_MS = 1000;

/** True once `active` has held for `delayMs`; false again the moment it does not, so each wait starts its own delay. */
export function useDelayedTrue(active: boolean, delayMs: number = SPINNER_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}
