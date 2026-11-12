import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayDir } from "../private-relay.ts";
import { adoptProcessGroup, STOP_BOUND_MS, stopProcessGroup } from "./process-group.ts";
import { liveWithEnvironment } from "./processes.ts";
import { withoutBunNodeShim } from "./node-path.ts";

const READY = /Ready on (http:\/\/\S+)/;
const START_TIMEOUT_MS = 90_000;
/**
 * The bound for a hook that stops a relay: the longest its process group's stop waits (STOP_BOUND_MS), plus 3 s for what
 * follows it. Measured under induced load (~160) over 20 stops: the group was gone in at most 3.8 s, never needing
 * SIGKILL; draining took 0 ms and removing the scratch at most 0.4 s. bun's 5 s hook default is shorter than the stop's
 * own SIGKILL path, so a slow stop was abandoned mid-way instead of finishing or failing with its own error.
 */
export const RELAY_STOP_MS = STOP_BOUND_MS + 3_000;
/** Each attempt binds a freshly picked HTTP port; the next attempt runs only after a proven bind race on it. */
const START_ATTEMPTS = 3;

export interface LocalRelay {
  /** e.g. `http://127.0.0.1:40123`. */
  readonly url: string;
  /** Everything wrangler printed so far, for failure messages. */
  output(): string;
  stop(): Promise<void>;
}

export interface LocalRelayOptions {
  /** For tests of this helper: picks each attempt's HTTP port, given the helper's own free-port picker. */
  readonly pickPort?: (pickFree: () => number) => number;
}

/** wrangler dev failed to bind the HTTP port this attempt picked: another process took it after the pick. */
export class BindRace extends Error {
  readonly port: number;

  constructor(port: number, output: string) {
    super(`127.0.0.1:${port} was taken between picking it and wrangler dev binding it:\n${output}`);
    this.port = port;
  }
}

/**
 * HTTP ports are picked below every default ephemeral range (Linux 32768-60999, macOS 49152-65535). The kernel hands
 * such a port to no port-0 bind or outgoing connection, so between the pick and wrangler's bind only a process that
 * names the same port can take it.
 */
const PICK_FROM = 20_000;
const PICK_TO = 32_768;
const PICK_TRIES = 100;

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

/** A port in the pick range that nothing listens on now. */
function freePort(): number {
  for (let tries = 0; tries < PICK_TRIES; tries++) {
    const port = PICK_FROM + Math.floor(Math.random() * (PICK_TO - PICK_FROM));
    try {
      Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
      return port;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw new Error(`no free port in ${PICK_FROM}-${PICK_TO - 1} after ${PICK_TRIES} tries`);
}

/** Runs `spawn`; if it throws, the scratch directory made for it is removed before the error propagates. */
async function removingOnFailure<T>(scratch: string, spawn: () => T): Promise<T> {
  try {
    return spawn();
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Runs the relay under workerd with `wrangler dev` on ports of its own, with wrangler's state, config and logs in a
 * scratch directory. Requires Node 22+ on PATH (wrangler's own requirement). `vars` become `--var` overrides, e.g.
 * short timeouts.
 *
 * The inspector and workerd's internal and direct sockets bind port 0, so the kernel hands each a port no other
 * process holds. The HTTP port must be known before the start (`--local-upstream` names it), so it is picked free and
 * released (see `freePort`), and a process naming the same port can still take it before wrangler binds it; only that
 * failure, naming exactly the port just picked, starts another attempt on a fresh port.
 */
export async function startLocalRelay(
  vars: Readonly<Record<string, string>> = {},
  options: LocalRelayOptions = {},
): Promise<LocalRelay> {
  const pickPort = options.pickPort ?? ((pickFree) => pickFree());
  const attempt = async (number: number, races: string): Promise<LocalRelay> => {
    try {
      return await startOnce(pickPort(freePort), vars, races);
    } catch (error) {
      if (!(error instanceof BindRace) || number === START_ATTEMPTS) throw error;
      const race = `[relay-dev] 127.0.0.1:${error.port} was taken before wrangler dev bound it; retrying on a fresh port\n`;
      return attempt(number + 1, races + race);
    }
  };
  return attempt(1, "");
}

async function startOnce(
  httpPort: number,
  vars: Readonly<Record<string, string>>,
  earlier: string,
): Promise<LocalRelay> {
  const dir = relayDir();
  const wrangler = join(dir, "node_modules", ".bin", "wrangler");
  if (!existsSync(wrangler)) {
    throw new Error(
      `no installed relay checkout at ${dir}: run \`bun run relay:test\`, which fetches the private relay first`,
    );
  }
  const scratch = await mkdtemp(join(tmpdir(), "relay-"));
  const port = String(httpPort);
  const logPath = join(scratch, "logs");
  const logMark = `WRANGLER_LOG_PATH=${logPath}`;
  const proc = await removingOnFailure(scratch, () =>
    Bun.spawn(
      [
        wrangler,
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        port,
        "--inspector-port",
        "0",
        // Without this, wrangler rewrites request URLs to the production route, and the relay origin hosts sign over
        // would not match the address they dialed.
        "--local-upstream",
        `127.0.0.1:${port}`,
        "--persist-to",
        join(scratch, "state"),
        ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
      ],
      {
        cwd: dir,
        // wrangler leads a process group of its own, so stopping it reaches the esbuild and workerd it starts.
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...withoutBunNodeShim(process.env),
          WRANGLER_SEND_METRICS: "false",
          XDG_CONFIG_HOME: join(scratch, "config"),
          WRANGLER_LOG_PATH: logPath,
        },
      },
    ),
  );
  adoptProcessGroup(proc, scratch);
  let output = earlier;
  const ready = Promise.withResolvers<string>();
  const bindRace = `Address already in use (127.0.0.1:${port})`;
  const failure = (code: number): Error =>
    output.includes(bindRace)
      ? new BindRace(httpPort, output)
      : new Error(`wrangler dev exited ${code} before ready:\n${output}`);
  // Both pipes are drained for the relay's whole life; a closed pipe would kill wrangler on its next write.
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      const url = READY.exec(output)?.[1];
      if (url !== undefined) ready.resolve(url);
      // wrangler's own error naming the port just picked proves the race; its exit can lag behind it.
      if (output.includes(bindRace)) ready.reject(new BindRace(httpPort, output));
    }
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  let stopping: Promise<void> | undefined;
  const stopGroup = (): Promise<void> => (stopping ??= stopProcessGroup(proc));
  // When wrangler exits, what it started may still hold its stderr; once the group is gone, the pipes are complete.
  const exited = async (): Promise<void> => {
    const code = await proc.exited;
    await stopGroup();
    await drained;
    ready.reject(failure(code));
  };
  void exited().catch((error: unknown) => ready.reject(error));
  const timer = setTimeout(
    () => ready.reject(new Error(`wrangler dev not ready in ${START_TIMEOUT_MS} ms:\n${output}`)),
    START_TIMEOUT_MS,
  );
  const stop = async (): Promise<void> => {
    await stopGroup();
    // Every process wrangler starts inherits this entry; one still carrying it left the group and outlived the stop.
    // It is killed before the pipes are awaited: a survivor holding wrangler's stdout or stderr keeps them open.
    const left = await liveWithEnvironment(logMark);
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await drained;
    await rm(scratch, { recursive: true, force: true });
    if (left.length > 0) throw new Error(`relay processes outlived stop() (now killed): ${left.join(", ")}`);
  };
  try {
    const url = await ready.promise;
    return { url, output: () => output, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
