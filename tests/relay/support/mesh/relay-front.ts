import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayDir } from "../../private-relay.ts";
import { testIp } from "../probe.ts";
import { within } from "../watch.ts";
import { processTable, signalAll, treeOf } from "./processes.ts";
import { makeTap, type Tap } from "./tap.ts";

export type { Tap } from "./tap.ts";

const READY = /Ready on (http:\/\/\S+)/;
const START_TIMEOUT_MS = 90_000;
const STOP_MS = 15_000;

export interface MeshRelay {
  /** The relay itself, for dials that are not a mesh host (an outsider's). */
  readonly url: string;
  /** The one source IP every tap gives: the design's H5 configuration has all hosts behind one address. */
  readonly ip: string;
  /** The `wrangler dev` process; its tree is the relay in the teardown receipt. */
  readonly pid: number;
  tapFor(): Tap;
  output(): string;
  stop(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/**
 * The pinned relay's own wrangler config without its production route. With a route, wrangler rewrites every request
 * URL to it, and the origin a host signs over (the tap's) would never match what the relay computes.
 */
function routeFreeConfig(dir: string): string {
  const parsed: unknown = Bun.JSONC.parse(readFileSync(join(dir, "wrangler.jsonc"), "utf8"));
  if (!isRecord(parsed) || typeof parsed["main"] !== "string")
    throw new Error("the relay's wrangler.jsonc has no main");
  const kept = Object.entries(parsed).filter(([name]) => name !== "routes" && name !== "$schema");
  return JSON.stringify({ ...Object.fromEntries(kept), main: join(dir, parsed["main"]) });
}

/** Runs the pinned private relay under `wrangler dev` with a route-free config, and hands out taps to it. */
export async function startMeshRelay(): Promise<MeshRelay> {
  const dir = relayDir();
  const wrangler = join(dir, "node_modules", ".bin", "wrangler");
  const scratch = mkdtempSync(join(tmpdir(), "mrelay-"));
  const config = join(scratch, "wrangler.json");
  writeFileSync(config, routeFreeConfig(dir));
  const port = freePort();
  const proc = Bun.spawn(
    [
      wrangler,
      "dev",
      "-c",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(freePort()),
      "--persist-to",
      join(scratch, "state"),
    ],
    {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        XDG_CONFIG_HOME: join(scratch, "config"),
        WRANGLER_LOG_PATH: join(scratch, "logs"),
      },
    },
  );
  let output = "";
  const ready = Promise.withResolvers<string>();
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      const url = READY.exec(output)?.[1];
      if (url !== undefined) ready.resolve(url);
    }
  };
  // Every process wrangler starts inherits these pipes, so they end only once the whole relay tree has exited.
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  void proc.exited.then((code) => ready.reject(new Error(`wrangler dev exited ${code} before ready:\n${output}`)));
  const timer = setTimeout(() => ready.reject(new Error(`wrangler dev not ready:\n${output}`)), START_TIMEOUT_MS);
  const taps: Tap[] = [];
  const ip = testIp();
  const stop = async (): Promise<void> => {
    for (const tap of taps) tap.stop();
    const tree = treeOf(await processTable(), proc.pid);
    signalAll(tree.toReversed(), "SIGTERM");
    await proc.exited;
    await within(drained, "the relay's processes exiting", STOP_MS).catch((error: unknown) => {
      signalAll(tree, "SIGKILL");
      throw error;
    });
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const url = await ready.promise;
    return {
      url,
      ip,
      pid: proc.pid,
      output: () => output,
      stop,
      tapFor() {
        const tap = makeTap(port, ip);
        taps.push(tap);
        return tap;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
