import { parentPort } from "node:worker_threads";
import { startLocalRelay } from "./relay-dev.ts";
import { RELAY_WORKER_DATA, type RelayWorkerData, type RelayWorkerMessage } from "./worker-relay.ts";

const port = parentPort;
if (port === null) throw new Error("local relay worker needs a parent");
const data = JSON.parse(process.env[RELAY_WORKER_DATA] ?? "{}") as RelayWorkerData;
const send = (message: RelayWorkerMessage): void => port.postMessage(message, []);
const cancel = new AbortController();
const stopping = Promise.withResolvers<void>();
port.once("message", () => {
  cancel.abort();
  stopping.resolve();
});
try {
  const relay = await startLocalRelay(data.vars, {
    ...(data.mesh === undefined ? {} : { mesh: data.mesh }),
    signal: cancel.signal,
    onOutput: (chunk) => send({ kind: "output", chunk }),
  });
  send({ kind: "ready", url: relay.url, pid: relay.pid });
  await stopping.promise;
  await relay.stop();
  send({ kind: "stopped" });
} catch (error) {
  if (!cancel.signal.aborted || error !== cancel.signal.reason) throw error;
  send({ kind: "stopped" });
} finally {
  port.close();
}
