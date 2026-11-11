import { useCallback, useRef } from "react";

/**
 * A function that stays the same object for the life of the component and always calls the latest `callback`: for a
 * context or memo that would otherwise change whenever the callback's own inputs do (#2086).
 */
export function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: A) => latest.current(...args), []);
}
