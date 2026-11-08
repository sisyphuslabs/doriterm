import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void): (() => void) => {
  addEventListener("online", listener);
  addEventListener("offline", listener);
  return () => {
    removeEventListener("online", listener);
    removeEventListener("offline", listener);
  };
};

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
