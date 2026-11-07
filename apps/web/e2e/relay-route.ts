import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Page } from "@playwright/test";
import { FAKE_RELAY } from "./capture-relay.ts";
import { E2E_WEB_PORT } from "./config.ts";

/**
 * A host across the network, reached the way a phone or laptop reaches one: through the relay, end to end encrypted.
 * fake-relay-host.ts runs it on a FakeRelay; `route` carries the page's relay sockets there.
 */
export interface FakeRelayHost {
  /** A fresh pairing link: each one pairs one device, once. */
  readonly pairingLink: () => Promise<string>;
  /** The same offer's typed code, from the same round trip, so a spec can prove the code path without a second offer. */
  readonly pairingOffer: () => Promise<{ readonly link: string; readonly code: string }>;
  /** Starts a second machine and runs `doriface-host mesh join` there with `link`; resolves with its mesh name. */
  readonly join: (link: string) => Promise<string>;
  /** The host's LAN listener, the address a person sets as the Direct address (#446); empty unless `direct` was asked. */
  readonly directUrl: string;
  /** Call before the page dials the relay: its `/v1/client/...` sockets go to the fake relay's client bridge. */
  readonly route: (page: Page) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * Carries the page's sockets on the production relay address (the only relay a release build dials, #389) to the relay
 * at `toRelay` instead, path and query kept. The e2e web server is a release build, so this is how a spec reaches a
 * test relay without the page knowing it is not the production one.
 */
export async function routeRelaySockets(page: Page, toRelay: string, pairUrl: string = toRelay): Promise<void> {
  const base = toRelay.replace(/\/+$/, "");
  // The code path is an HTTP lookup, not a socket: without this the page asks the production relay for a slot only the
  // test relay holds, and every typed code answers "no host is pairing with this code".
  const httpRelay = FAKE_RELAY.replace(/^wss:/, "https:").replaceAll(".", "\\.");
  await page.route(new RegExp(`^${httpRelay}/v1/pair/`), async (route) => {
    const target = new URL(route.request().url());
    const answer = await fetch(`${pairUrl}${target.pathname}`);
    // The body is decoded here, so the upstream framing headers would describe bytes this is not: keep the type and let
    // the fulfilled response pay for its own length. A compressed lookup answer would otherwise ship a stale encoding.
    await route.fulfill({
      status: answer.status,
      headers: {
        "content-type": answer.headers.get("content-type") ?? "application/json",
        "access-control-allow-origin": "*",
      },
      body: await answer.text(),
    });
  });
  await page.routeWebSocket(new RegExp(`^${FAKE_RELAY.replaceAll(".", "\\.")}/v1/client/`), (socket) => {
    const target = new URL(socket.url());
    const relay = new WebSocket(`${base}${target.pathname}${target.search}`);
    relay.binaryType = "arraybuffer";
    const early: (string | Uint8Array<ArrayBuffer>)[] = [];
    relay.addEventListener("open", () => {
      for (const frame of early.splice(0)) relay.send(frame);
    });
    socket.onMessage((message) => {
      const frame = typeof message === "string" ? message : Uint8Array.from(message);
      if (relay.readyState === WebSocket.OPEN) relay.send(frame);
      else early.push(frame);
    });
    relay.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) =>
      socket.send(typeof event.data === "string" ? event.data : Buffer.from(event.data)),
    );
    relay.addEventListener("close", (event) => void socket.close({ code: event.code, reason: event.reason }));
    socket.onClose(() => relay.close());
  });
}

/**
 * How long one startup stage may take before the start fails naming it (#502). Measured on a 40-core host before this
 * bound existed: the slowest stage is the added machine's `hc machine add`, 41-54 ms idle and 90-120 ms at load ~113,
 * and the whole start is 280-356 ms idle and 368-463 ms loaded. A stage that is merely slow therefore stays far inside
 * this, while a stage that is blocked fails in ten seconds naming itself instead of running out a hook's 60 s silently.
 */
export const STAGE_DEADLINE_MS = 10_000;

/** What arms a wait's deadline: `run` once `ms` have passed, unless the returned cancel runs first. */
export interface DeadlineClock {
  after(ms: number, run: () => void): () => void;
}

const realClock: DeadlineClock = {
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** A startup whose lines this reads: `startFakeRelayHost` runs fake-relay-host.ts, and the whole file's contract is
 * the protocol its command prints. */
interface Startup {
  /**
   * Prints one `{"stage": <name>, "ms": <n>}` line per startup stage it finishes, then `{"bridge": <url>}` once clients
   * can be routed, then one `{"link": <url>}` per `link` line read on its stdin, until that stdin ends or it is stopped.
   */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly stageDeadlineMs: number;
  /** The stage whose report starts the deadline's clock; without one it runs from the start of each wait. */
  readonly stageDeadlineFrom?: string;
  readonly clock: DeadlineClock;
  /**
   * The command also serves the LAN listener and prints `directUrl`: only the spec that sets a Direct address asks for
   * that listener and reads the address (#446).
   */
  readonly direct?: boolean;
}

type Line = Record<string, unknown>;

interface Waiter {
  readonly resolve: (line: Line) => void;
  readonly reject: (error: Error) => void;
}

function isLine(value: unknown): value is Line {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The driver's lines, with the stage it is in. A wait fails at once when the driver exits, so a start that died is
 * never waited out (#502), and it fails naming the stage when that stage outlasts `deadlineMs`, so a start that is
 * blocked says where instead of running out the hook's time. With `deadlineFrom`, a wait's deadline runs only once that
 * stage is reported, so the stage it lands in does not depend on how fast the host reached it (#692).
 */
function readProtocol(
  driver: ChildProcess,
  deadlineMs: number,
  deadlineFrom: string | undefined,
  clock: DeadlineClock,
): { readonly next: (what: string, waitMs?: number) => Promise<Line> } {
  const out = driver.stdout;
  if (out === null) throw new Error("the fake relay host has no stdout");
  const lines = createInterface({ input: out });
  const waiting: Waiter[] = [];
  const queued: Line[] = [];
  const done: string[] = [];
  let stage = "its first stage";
  let ended: Error | undefined;
  let clockRunning = deadlineFrom === undefined;
  const armWhenRunning: (() => void)[] = [];

  const where = (): string => `it is in ${stage}${done.length === 0 ? "" : ` (done: ${done.join(", ")})`}`;
  const fail = (error: Error): void => {
    ended ??= error;
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };

  void (async () => {
    for await (const line of lines) {
      if (!line.startsWith("{")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error(`the fake relay host printed a line that is not its protocol: ${line.slice(0, 200)}`));
        return;
      }
      if (!isLine(parsed)) continue;
      const reported = parsed["stage"];
      if (typeof reported === "string") {
        done.push(`${reported} ${String(parsed["ms"] ?? 0)} ms`);
        stage = reported;
        if (reported === deadlineFrom && !clockRunning) {
          clockRunning = true;
          for (const arm of armWhenRunning.splice(0)) arm();
        }
        continue;
      }
      const waiter = waiting.shift();
      if (waiter === undefined) queued.push(parsed);
      else waiter.resolve(parsed);
    }
    // Its exit is a tick behind the end of its stdout: wait for the code, so the failure can carry it.
    await exited(driver, 1_000);
    fail(
      new Error(
        `the fake relay host exited (code ${String(driver.exitCode ?? driver.signalCode ?? "unknown")}) while ${where()}; see its stderr above`,
      ),
    );
  })();

  const next = (what: string, waitMs = deadlineMs): Promise<Line> =>
    new Promise<Line>((resolve, reject) => {
      let cancel: (() => void) | undefined;
      const waiter: Waiter = {
        resolve: (line) => {
          cancel?.();
          resolve(line);
        },
        reject: (error) => {
          cancel?.();
          reject(error);
        },
      };
      const arrived = queued.shift();
      if (arrived !== undefined) {
        waiter.resolve(arrived);
        return;
      }
      if (ended !== undefined) {
        waiter.reject(ended);
        return;
      }
      waiting.push(waiter);
      const arm = (): void => {
        if (!waiting.includes(waiter)) return;
        cancel = clock.after(waitMs, () => {
          const at = waiting.indexOf(waiter);
          if (at < 0) return;
          waiting.splice(at, 1);
          reject(
            new Error(
              `the fake relay host did not finish ${what} within ${waitMs} ms: ${where()}, and it printed no error`,
            ),
          );
        });
      };
      if (clockRunning) arm();
      else armWhenRunning.push(arm);
    });

  return { next };
}

/** Resolves when the driver has exited, or after `withinMs`: the web tsconfig types `ChildProcess` without events. */
function exited(driver: ChildProcess, withinMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + withinMs;
    const tick = setInterval(() => {
      if (driver.exitCode === null && driver.signalCode === null && Date.now() < deadline) return;
      clearInterval(tick);
      resolve();
    }, 50);
  });
}

/** Starts a driver and waits for its bridge; a start that dies or blocks fails at once, naming the stage it reached. */
async function startDriver(options: Startup): Promise<FakeRelayHost> {
  const deadlineMs = options.stageDeadlineMs;
  const [program, ...args] = options.command;
  if (program === undefined) throw new Error("the fake relay host has no command to run");
  const driver = spawn(program, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "inherit"] });
  const input = driver.stdin;
  if (input === null) throw new Error("the fake relay host has no stdin");
  const protocol = readProtocol(driver, deadlineMs, options.stageDeadlineFrom, options.clock);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (driver.exitCode !== null || driver.signalCode !== null) return;
      try {
        input.end();
      } catch {
        // Its stdin is gone already, and the line reader holds the reason the start failed.
      }
      driver.kill("SIGTERM");
      await exited(driver, deadlineMs);
      if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
    })();
    return stopping;
  };

  try {
    const first = await protocol.next("the bridge");
    const bridge = first["bridge"];
    const directUrl = first["directUrl"];
    const pairUrl = first["pairUrl"];
    if (typeof bridge !== "string") throw new Error("the fake relay host printed no bridge");
    if (typeof pairUrl !== "string") throw new Error("the fake relay host printed no pair lookup address");
    if (options.direct === true && (typeof directUrl !== "string" || directUrl === ""))
      throw new Error("the fake relay host printed no direct address");
    const readOffer = async (): Promise<{ readonly link: string; readonly code: string }> => {
      input.write("link\n");
      const { link, code } = await protocol.next("a pairing link");
      if (typeof link !== "string" || typeof code !== "string")
        throw new Error("the fake relay host printed no pairing link or code");
      return { link, code };
    };
    return {
      directUrl: typeof directUrl === "string" ? directUrl : "",
      pairingOffer: readOffer,
      pairingLink: async () => (await readOffer()).link,
      async join(link) {
        input.write(`join ${link}\n`);
        // A second core, a second host and a join through the relay: more than one startup stage's worth.
        const { joined } = await protocol.next("a joined machine", 60_000);
        if (typeof joined !== "string") throw new Error("the fake relay host printed no joined machine");
        return joined;
      },
      route: (page) => routeRelaySockets(page, bridge, pairUrl),
      stop,
    };
  } catch (error) {
    // A start that failed stops its driver: a stalled or dead fake host would otherwise keep cores for the next spec.
    await stop();
    throw error;
  }
}

/**
 * `machine`: the host's core also has an added machine (the sidebar then lists machines with their state).
 * `direct`: the host also serves `/v1/e2ee` on a LAN listener, the address a Direct-address spec sets (#446); without it
 * no listener is started and `directUrl` is empty.
 * `stageDeadlineMs`: a shorter stage deadline, for a test that proves the bound without a blocked start running 10 s.
 * `stageDeadlineFrom`: the stage whose report starts that deadline, for a test that proves which stage a blocked start
 * names: the test then decides where the deadline lands, not the host's speed (#692).
 * `clock`: what runs those deadlines, for a test that proves when a wait's deadline is armed: on a clock the test moves,
 * that is decided by the test, not by how fast the host answers (#780).
 */
export function startFakeRelayHost(
  options: {
    readonly machine?: boolean;
    /** The host's core already runs one shell, named `existing`, before any device pairs. */
    readonly terminal?: boolean;
    readonly stageDeadlineMs?: number;
    /** Where the host's first space starts. A capture points this at a plain directory so no git state reaches the shot. */
    readonly cwd?: string;
    readonly stageDeadlineFrom?: string;
    readonly direct?: boolean;
    readonly clock?: DeadlineClock;
  } = {},
): Promise<FakeRelayHost> {
  return startDriver({
    clock: options.clock ?? realClock,
    ...(options.stageDeadlineFrom === undefined ? {} : { stageDeadlineFrom: options.stageDeadlineFrom }),
    direct: options.direct === true,
    command: [
      "bun",
      join(import.meta.dirname, "fake-relay-host.ts"),
      `http://127.0.0.1:${E2E_WEB_PORT}`,
      FAKE_RELAY,
      ...(options.machine === true ? ["--machine"] : []),
      ...(options.terminal === true ? ["--terminal"] : []),
      ...(options.direct === true ? ["--direct"] : []),
    ],
    cwd: options.cwd ?? join(import.meta.dirname, ".."),
    stageDeadlineMs: options.stageDeadlineMs ?? STAGE_DEADLINE_MS,
  });
}
