import type { LocalRelayOptions, RelayProcess } from "./relay-dev.ts";

/** The environment variable that carries a worker's RelayWorkerData as JSON (Bun's Worker takes `env`, not workerData). */
export const RELAY_WORKER_DATA = "DORIFACE_RELAY_WORKER_DATA";

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
  const worker = new Worker(new URL("./relay-worker.ts", import.meta.url), {
    env: { ...process.env, [RELAY_WORKER_DATA]: JSON.stringify(workerData) },
  });
  const ready = Promise.withResolvers<RelayProcess>();
  let output = "";
  let failure: Error | undefined;
  let ended = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  // Bun's Worker reports its end as a `close` event; the worker is terminated once it reports `stopped`.
  const exited = new Promise<void>((resolve) => {
    worker.addEventListener(
      "close",
      (event) => {
        ended = true;
        const code: unknown = Reflect.get(event, "code");
        if (stopping === undefined || !stopped) {
          failure ??= new Error(`local relay worker exited without completing teardown (code ${String(code)})`);
        }
        ready.reject(failure ?? new Error("local relay worker stopped before it was ready"));
        resolve();
      },
      { once: true },
    );
  });
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      if (!ended) worker.postMessage("stop", []);
      await exited;
      if (failure !== undefined) throw failure;
    })());
  worker.addEventListener("error", (event) => {
    failure = new Error(`local relay worker failed: ${event.message}`, { cause: event.error });
    ready.reject(failure);
  });
  worker.addEventListener("message", (event: MessageEvent<RelayWorkerMessage>) => {
    const message = event.data;
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
        worker.terminate();
        break;
    }
  });
  return { ready: ready.promise, stop };
}
