import { useEffect, useReducer, useRef } from "react";
import { type AgentPlaces, placeAgents } from "./agent-places.ts";
import type { Session } from "./attention.ts";

/**
 * The agents' places for the status groups (`placeAgents`), kept across renders and placed again when a pending move
 * between Working and Idle falls due, so the row moves then even if nothing else changes (#1949).
 */
export function useAgentPlaces(terminals: readonly Session[]): AgentPlaces {
  const places = useRef<AgentPlaces>(new Map());
  const [tick, wake] = useReducer((count: number) => count + 1, 0);
  const placed = placeAgents(places.current, terminals, Date.now());
  places.current = placed.places;
  const { due } = placed;
  useEffect(() => {
    if (due === null) return undefined;
    const timer = setTimeout(wake, Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [due, tick]);
  return placed.places;
}
