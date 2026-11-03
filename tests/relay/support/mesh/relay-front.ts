import type { Socket } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayDir } from "../../private-relay.ts";
import { testIp } from "../probe.ts";

const READY = /Ready on (http:\/\/\S+)/;
const START_TIMEOUT_MS = 90_000;
const CRLF = "\r\n";

/** One host's door to the relay: a TCP forwarder that names the host's source IP and can be cut and healed. */
export interface Tap {
  /** What the host is given as `--relay`. Its port is part of the origin the host signs over. */
  readonly url: string;
  /** The `cf-connecting-ip` this tap sets, so the relay's per-IP budgets see it as the host's address. */
  readonly ip: string;
  /** Bytes forwarded in both directions. */
  bytes(): number;
  /** Connections currently open through the tap. */
  open(): number;
  /** Closes every connection and refuses new ones, as a network partition from this host's side. */
  cut(): void;
  heal(): void;
  stop(): void;
}

export interface MeshRelay {
  /** The relay itself, for dials that are not a mesh host (an outsider's). */
  readonly url: string;
  /** The one source IP every tap gives: the design's H5 configuration has all hosts behind one address. */
  readonly ip: string;
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

interface Conn {
  up: Socket<undefined> | undefined;
  head: string;
  headDone: boolean;
  queue: Uint8Array[];
}

function makeTap(upstreamPort: number, ip: string): Tap {
  const conns = new Set<Socket<Conn>>();
  let forwarded = 0;
  let cut = false;
  const forward = (conn: Conn, bytes: Uint8Array): void => {
    forwarded += bytes.length;
    if (conn.up === undefined) conn.queue.push(bytes);
    else conn.up.write(bytes);
  };
  const listener = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        if (cut) return void socket.end();
        const conn: Conn = { up: undefined, head: "", headDone: false, queue: [] };
        socket.data = conn;
        conns.add(socket);
        void Bun.connect({
          hostname: "127.0.0.1",
          port: upstreamPort,
          socket: {
            data(_up, bytes) {
              forwarded += bytes.length;
              socket.write(bytes);
            },
            close() {
              socket.end();
            },
            error() {
              socket.end();
            },
          },
        }).then(
          (up) => {
            conn.up = up;
            for (const queued of conn.queue.splice(0)) up.write(queued);
            if (cut) up.end();
            return undefined;
          },
          () => socket.end(),
        );
      },
      data(socket, bytes) {
        const conn = socket.data;
        if (conn.headDone) return forward(conn, bytes);
        // The IP header goes in right after the request line, before the first header.
        conn.head += Buffer.from(bytes).toString("latin1");
        const end = conn.head.indexOf(CRLF);
        if (end < 0) return;
        conn.headDone = true;
        const line = conn.head.slice(0, end + CRLF.length);
        forward(conn, Buffer.from(`${line}cf-connecting-ip: ${ip}${CRLF}${conn.head.slice(line.length)}`, "latin1"));
        conn.head = "";
      },
      close(socket) {
        conns.delete(socket);
        socket.data.up?.end();
      },
      error(socket) {
        socket.end();
      },
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}`,
    ip,
    bytes: () => forwarded,
    open: () => conns.size,
    cut() {
      cut = true;
      for (const socket of conns) socket.end();
    },
    heal() {
      cut = false;
    },
    stop() {
      cut = true;
      for (const socket of conns) socket.end();
      listener.stop(true);
    },
  };
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
  void Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  void proc.exited.then((code) => ready.reject(new Error(`wrangler dev exited ${code} before ready:\n${output}`)));
  const timer = setTimeout(() => ready.reject(new Error(`wrangler dev not ready:\n${output}`)), START_TIMEOUT_MS);
  const taps: Tap[] = [];
  const ip = testIp();
  const stop = async (): Promise<void> => {
    for (const tap of taps) tap.stop();
    proc.kill("SIGTERM");
    await proc.exited;
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const url = await ready.promise;
    return {
      url,
      ip,
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
