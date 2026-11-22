import { afterAll } from "bun:test";
import { onInterrupt } from "./process-group.ts";
import { type LocalRelay, RELAY_STOP_MS } from "./relay-dev.ts";
import { setUpOnce } from "./set-up-once.ts";
import { startRelayWorker } from "./worker-relay.ts";

export function useLocalRelay(vars: Readonly<Record<string, string>> = {}): Pick<LocalRelay, "url"> {
  let relay: LocalRelay | undefined;
  let worker: ReturnType<typeof startRelayWorker> | undefined;
  let unregister: (() => void) | undefined;
  setUpOnce(async () => {
    worker = startRelayWorker({ vars });
    unregister = onInterrupt(worker.stop);
    relay = await worker.ready;
  }, 120_000);
  afterAll(async () => {
    try {
      await worker?.stop();
    } finally {
      unregister?.();
    }
  }, RELAY_STOP_MS);
  return {
    get url() {
      if (relay === undefined) throw new Error("local relay is not running");
      return relay.url;
    },
  };
}
