import { useContext, useEffect } from "react";
import { ActionsPaused } from "./dispatcher.ts";

/** Workspace overlays leave the DOM and close their state when Settings pauses their owner. */
export function useOverlayActive(onClose: () => void): boolean {
  const paused = useContext(ActionsPaused);
  useEffect(() => {
    if (paused) onClose();
  }, [paused, onClose]);
  return !paused;
}
