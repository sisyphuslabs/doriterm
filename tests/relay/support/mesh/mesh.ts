import type { HcConnection } from "@doriface/client";
import { within } from "../watch.ts";
import { type MeshHost, startMeshHost } from "./mesh-host.ts";
import { isAlive, type Owned, processTable, treeOf } from "./processes.ts";
import { type MeshRelay, startMeshRelay } from "./relay-front.ts";

export const HOST_NAMES = ["a", "b", "c", "d"] as const;
export type HostName = (typeof HOST_NAMES)[number];

const WAIT_MS = 60_000;
/**
 * How often `until` re-reads its condition between wakes. Some state changes nothing reports: hc's event feed carries
 * terminal, status and doc events only, so a machine's line turning `connected` is seen by reading `machine.list` again.
 */
export const REREAD_MS = 500;
const OFFER_URL = /https:\/\/\S*pair#\S+/;

export interface Receipt {
  /** Every process the mesh started, by kind: hosts, CLI runs, hc connects, hc cores and the relay's tree. */
  readonly owned: readonly Owned[];
  readonly alive: readonly Owned[];
  /** Tap ports that still accept a connection. */
  readonly listening: readonly number[];
}

export interface Mesh {
  readonly relay: MeshRelay | undefined;
  readonly hosts: readonly MeshHost[];
  host(name: string): MeshHost;
  /** A cached hc connection to a host's own core; any event on it re-evaluates pending `until` checks. */
  core(name: string): Promise<HcConnection>;
  /** Calls `wake` on every host log line, state write, core event and tap open or close, until the returned function is called. */
  onWake(wake: () => void): () => void;
  /** Waits for `check` to hold, re-evaluating it on every wake and re-reading it every {@link REREAD_MS} meanwhile. */
  until(what: string, check: () => Promise<boolean> | boolean, ms?: number): Promise<void>;
  /** `mesh pair --auto` on `inviter`, then `mesh join` on `joiner`: the only operator steps a join takes. */
  join(inviter: string, joiner: string): Promise<void>;
  dispose(): Promise<Receipt>;
}

export interface MeshOptions {
  readonly names?: readonly string[];
  /** A relay to use as it is (the production one); without it a local relay is started and every host gets a tap. */
  readonly relayUrl?: string;
}

/** Runs `check` on each wake, one evaluation at a time, re-running once if a wake came in meanwhile. */
export function coalesce(check: () => Promise<void>, failed: (error: unknown) => void): () => void {
  let running = false;
  let again = false;
  const evaluate = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    const pass = async (): Promise<void> => {
      again = false;
      await check();
      if (again) return pass();
    };
    try {
      await pass();
    } catch (error) {
      failed(error);
    } finally {
      running = false;
    }
  };
  return () => void evaluate();
}

/**
 * Waits up to `ms` for `check` to hold. It is evaluated at once, on every wake, and every `rereadMs` in between, for
 * state that changes without a wake; one evaluation runs at a time, and the re-reads stop when the wait ends.
 */
export async function untilHolds(
  onWake: (wake: () => void) => () => void,
  what: string,
  check: () => Promise<boolean> | boolean,
  ms = WAIT_MS,
  rereadMs = REREAD_MS,
): Promise<void> {
  const done = Promise.withResolvers<void>();
  const wake = coalesce(async () => {
    if (await check()) done.resolve();
  }, done.reject);
  const off = onWake(wake);
  const reread = setInterval(wake, rereadMs);
  wake();
  try {
    await within(done.promise, what, ms);
  } finally {
    clearInterval(reread);
    off();
  }
}

async function portListens(port: number): Promise<boolean> {
  return Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }).then(
    (socket) => {
      socket.end();
      return true;
    },
    () => false,
  );
}

export async function startMesh(options: MeshOptions = {}): Promise<Mesh> {
  const names = options.names ?? HOST_NAMES;
  const relay = options.relayUrl === undefined ? await startMeshRelay() : undefined;
  const hosts: MeshHost[] = [];
  const cores = new Map<string, Promise<HcConnection>>();
  const wakes = new Set<() => void>();
  const closers: (() => void)[] = [];
  const wakeAll = (): void => {
    for (const wake of wakes) wake();
  };
  const dispose = async (): Promise<Receipt> => {
    const coreStatuses = await Promise.all(
      hosts.map(async (each) => (await core(each.name)).call("server.status").catch(() => undefined)),
    );
    const rows = await processTable();
    const owned: Owned[] = [
      ...(relay === undefined ? [] : treeOf(rows, relay.pid).map((pid): Owned => ({ kind: "relay", pid }))),
      ...hosts.flatMap((host) =>
        host.owned().flatMap((own) => treeOf(rows, own.pid).map((pid): Owned => ({ kind: own.kind, pid }))),
      ),
      ...coreStatuses.flatMap((status) =>
        status === undefined ? [] : treeOf(rows, status.pid).map((pid): Owned => ({ kind: "hc-core", pid })),
      ),
    ];
    for (const close of closers.splice(0)) close();
    await Promise.all(hosts.map((host) => host.dispose()));
    await relay?.stop();
    const ports = hosts.flatMap((host) => (host.tap === undefined ? [] : [host.tap.port]));
    const listening = (await Promise.all(ports.map(async (port) => ((await portListens(port)) ? [port] : [])))).flat();
    return { owned, alive: owned.filter((own) => isAlive(own.pid)), listening };
  };
  const starts = await Promise.allSettled(
    names.map(async (name) => {
      const tap = relay?.tapFor();
      const url = tap?.url ?? options.relayUrl;
      if (url === undefined) throw new Error("no relay to dial");
      tap?.onChange(wakeAll);
      const host = await startMeshHost({ name, relayUrl: url, tap });
      host.onActivity(wakeAll);
      hosts.push(host);
    }),
  );
  const failed = starts.find((start) => start.status === "rejected");
  if (failed !== undefined) {
    await Promise.all(hosts.map((each) => each.dispose()));
    await relay?.stop();
    throw failed.reason;
  }
  hosts.sort((x, y) => names.indexOf(x.name) - names.indexOf(y.name));
  const host = (name: string): MeshHost => {
    const found = hosts.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no host ${name}`);
    return found;
  };
  const core = (name: string): Promise<HcConnection> => {
    const cached = cores.get(name);
    if (cached !== undefined) return cached;
    const opened = host(name)
      .core()
      .then(async (connection) => {
        const feed = await connection.subscribe();
        feed.onEvent(wakeAll);
        closers.push(
          () => feed.close(),
          () => connection.close(),
        );
        return connection;
      });
    cores.set(name, opened);
    return opened;
  };
  const onWake = (wake: () => void): (() => void) => {
    wakes.add(wake);
    return () => wakes.delete(wake);
  };
  const until = (what: string, check: () => Promise<boolean> | boolean, ms = WAIT_MS): Promise<void> =>
    untilHolds(onWake, what, check, ms);
  const join = async (inviter: string, joiner: string): Promise<void> => {
    const from = host(inviter);
    const relayUrl = from.tap?.url ?? options.relayUrl ?? "";
    const offer = await from.cli(
      "mesh",
      "pair",
      "--auto",
      "--no-qr",
      "--web-origin",
      "https://web.example",
      "--relay",
      relayUrl,
    );
    const link = OFFER_URL.exec(offer.stdout)?.[0];
    if (offer.exit !== 0 || link === undefined) {
      throw new Error(`mesh pair on ${inviter} failed: ${offer.stderr}${offer.stdout}`);
    }
    const joined = await host(joiner).cli("mesh", "join", link, "--yes", "--name", joiner);
    if (joined.exit !== 0) throw new Error(`mesh join on ${joiner} failed: ${joined.stderr}${joined.stdout}`);
  };
  return { relay, hosts, host, core, onWake, until, join, dispose };
}
