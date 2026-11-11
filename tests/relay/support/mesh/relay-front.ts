import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayDir } from "../../private-relay.ts";
import { testIp } from "../probe.ts";
import { within } from "../watch.ts";
import { adoptProcessGroup, stopProcessGroup } from "../process-group.ts";
import { makeTap, type Tap } from "./tap.ts";

export type { Tap } from "./tap.ts";

const READY = /Ready on (http:\/\/\S+)/;
const START_TIMEOUT_MS = 90_000;
const STOP_MS = 15_000;
/** How long a started relay may take to answer its first `GET /healthz`. */
const ANSWER_MS = 15_000;
/** The longest {@link MeshRelay.restart} may take: the stop, the start and the first answer after it. */
export const RESTART_BUDGET_MS = STOP_MS + START_TIMEOUT_MS + ANSWER_MS;

export interface MeshRelay {
  /** The relay itself, for dials that are not a mesh host (an outsider's). */
  readonly url: string;
  /** The one source IP every tap gives: the design's H5 configuration has all hosts behind one address. */
  readonly ip: string;
  /** The `wrangler dev` process; its tree is the relay in the teardown receipt. */
  readonly pid: number;
  tapFor(): Tap;
  output(): string;
  /** When each proven upgrade's log line (`"ev":"proven"`) arrived, in ms: the peak per 60 s is countable from it. */
  provenAt(): readonly number[];
  stop(): Promise<void>;
  /**
   * Restarts the relay behind its held front: same public port and persisted Durable Object state (design E-RELAY,
   * E-IP). Resolves once the relay answers `GET /healthz` again, the moment a recovery bound counts from.
   */
  restart(): Promise<void>;
}

interface Launched {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  /** Ends once every process of this launch has exited (they all inherit the pipes). */
  readonly drained: Promise<unknown>;
  readonly ready: Promise<string>;
}

/** Stops one launch's process group and waits until every process of it has exited. */
async function stopLaunch({ proc, drained }: Launched): Promise<void> {
  await stopProcessGroup(proc);
  await within(drained, "the relay's processes exiting", STOP_MS);
}

/** Resolves once the relay at `url` answers `GET /healthz` with 200, not merely once wrangler printed its banner. */
async function answers(url: string): Promise<void> {
  const response = await within(fetch(`${url}/healthz`), "the relay answering GET /healthz", ANSWER_MS);
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`the relay answered GET /healthz with ${response.status}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

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
  // Keep the public socket bound through restarts. Every workerd launch gets its port from the kernel, rather than
  // racing another process between a free-port probe and wrangler's eventual bind (#1015).
  let upstreamPort = 0;
  const front = makeTap(() => upstreamPort);
  let output = "";
  let scanned = 0;
  const provenAt: number[] = [];
  const scan = (): void => {
    for (let end = output.indexOf("\n", scanned); end >= 0; end = output.indexOf("\n", scanned)) {
      if (output.slice(scanned, end).includes('"ev":"proven"')) provenAt.push(Date.now());
      scanned = end + 1;
    }
  };
  const launch = (): Launched => {
    const proc = Bun.spawn(
      [
        wrangler,
        "dev",
        "-c",
        config,
        "--ip",
        "127.0.0.1",
        "--port",
        "0",
        "--inspector-port",
        "0",
        "--persist-to",
        join(scratch, "state"),
      ],
      {
        cwd: dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // A group of its own, adopted: an interrupt of the test runner ends wrangler and every workerd it started.
        detached: true,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          XDG_CONFIG_HOME: join(scratch, "config"),
          WRANGLER_LOG_PATH: join(scratch, "logs"),
        },
      },
    );
    adoptProcessGroup(proc, scratch);
    const from = output.length;
    const ready = Promise.withResolvers<string>();
    const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        output += decoder.decode(chunk, { stream: true });
        scan();
        const url = READY.exec(output.slice(from))?.[1];
        if (url !== undefined) ready.resolve(url);
      }
    };
    // Every process wrangler starts inherits these pipes, so they end only once the whole relay tree has exited.
    const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    void proc.exited.then((code) => ready.reject(new Error(`wrangler dev exited ${code} before ready:\n${output}`)));
    const timer = setTimeout(() => ready.reject(new Error(`wrangler dev not ready:\n${output}`)), START_TIMEOUT_MS);
    void ready.promise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    return { proc, drained, ready: ready.promise };
  };
  let current = launch();
  const taps: Tap[] = [front];
  const ip = testIp();
  const stop = async (): Promise<void> => {
    for (const tap of taps) tap.stop();
    try {
      await stopLaunch(current);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  try {
    upstreamPort = Number(new URL(await current.ready).port);
    return {
      url: front.url,
      ip,
      get pid() {
        return current.proc.pid;
      },
      output: () => output,
      provenAt: () => provenAt,
      stop,
      async restart() {
        upstreamPort = 0;
        await stopLaunch(current);
        current = launch();
        upstreamPort = Number(new URL(await current.ready).port);
        await answers(front.url);
      },
      tapFor() {
        const tap = makeTap(front.port, ip);
        taps.push(tap);
        return tap;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
