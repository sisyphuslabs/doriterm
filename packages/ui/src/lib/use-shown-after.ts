import { useEffect, useState } from "react";
import { ShowGate, type ShowTiming } from "./show-gate.ts";
import { SPINNER_DELAY_MS } from "./spinner-delay.ts";

/** How long an indicator, once it appeared, stays on screen at the least. */
export const INDICATOR_MIN_MS = 500;

export const INDICATOR_TIMING: ShowTiming = { delayMs: SPINNER_DELAY_MS, minMs: INDICATOR_MIN_MS };

/** Whether a wait's indicator is on screen now, per {@link ShowGate}: true only past the delay, then held its minimum. */
export function useShownAfter(active: boolean, timing: ShowTiming = INDICATOR_TIMING): boolean {
  const [gate] = useState(() => ({ current: undefined as ShowGate | undefined }));
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const created = new ShowGate(timing, setShown);
    gate.current = created;
    return () => created.stop();
  }, [gate, timing.delayMs, timing.minMs]);
  useEffect(() => {
    gate.current?.set(active);
  }, [gate, active, timing.delayMs, timing.minMs]);
  return shown;
}
