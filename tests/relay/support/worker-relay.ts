import { Worker } from "node:worker_threads";
import type { LocalRelayOptions, RelayProcess } from "./relay-dev.ts";

export interface RelayWorkerData {
  readonly vars?: Readonly<Record<string, string>>;
  readonly mesh?: NonNullable<LocalRelayOptions["mesh"]>;
}

export type RelayWorkerMessage =
  | { readonly kind: "ready"; readonly url: string; readonly pid: number }
  | { readonly kind: "output"; readonly chunk: string }
  | { readonly kind: "stopped" };

/** Start Wrangler in a different VM, outside Bun's test-timeout process sweep. */
export function startRelayWorker(
  workerData: RelayWorkerData = {},
  onOutput?: (chunk: string) => void,
): { readonly ready: Promise<RelayProcess>; stop(): Promise<void> } {
  const worker = new Worker(new URL("./relay-worker.ts", import.meta.url), { workerData, env: { ...process.env } });
  const ready = Promise.withResolvers<RelayProcess>();
  let output = "";
  let failure: Error | undefined;
  let ended = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => {
    worker.once("exit", (code) => {
      ended = true;
      if (stopping === undefined || code !== 0 || !stopped) {
        failure ??= new Error(`local relay worker exited without completing teardown (code ${code})`);
      }
      ready.reject(failure ?? new Error("local relay worker stopped before it was ready"));
      resolve();
    });
  });
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      if (!ended) worker.postMessage("stop", []);
      await exited;
      if (failure !== undefined) throw failure;
    })());
  worker.on("error", (error) => {
    failure = error instanceof Error ? error : new Error("local relay worker failed", { cause: error });
    ready.reject(failure);
  });
  worker.on("message", (message: RelayWorkerMessage) => {
    switch (message.kind) {
      case "ready":
        ready.resolve({ url: message.url, pid: message.pid, output: () => output, stop });
        break;
      case "output":
        output += message.chunk;
        onOutput?.(message.chunk);
        break;
      case "stopped":
        stopped = true;
        break;
    }
  });
  return { ready: ready.promise, stop };
}
