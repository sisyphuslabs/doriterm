import type { HcConnection } from "@doriface/client";
import { within } from "../watch.ts";
import { type MeshHost, startMeshHost } from "./mesh-host.ts";
import { type MeshRelay, startMeshRelay } from "./relay-front.ts";

export const HOST_NAMES = ["a", "b", "c", "d"] as const;
export type HostName = (typeof HOST_NAMES)[number];

const WAIT_MS = 60_000;
const OFFER_URL = /https:\/\/\S*pair#\S+/;

export interface Receipt {
  readonly pids: readonly number[];
  readonly alive: readonly number[];
}

export interface Mesh {
  readonly relay: MeshRelay | undefined;
  readonly hosts: readonly MeshHost[];
  host(name: string): MeshHost;
  /** A cached hc connection to a host's own core; any event on it re-evaluates pending `until` checks. */
  core(name: string): Promise<HcConnection>;
  /** Waits for `check` to hold, re-evaluating it on every host log line and core event; never on a timer. */
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

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

export async function startMesh(options: MeshOptions = {}): Promise<Mesh> {
  const names = options.names ?? HOST_NAMES;
  const relay = options.relayUrl === undefined ? await startMeshRelay() : undefined;
  const hosts: MeshHost[] = [];
  const cores = new Map<string, Promise<HcConnection>>();
  const wakes = new Set<() => void>();
  const closers: (() => void)[] = [];
  const dispose = async (): Promise<Receipt> => {
    for (const close of closers.splice(0)) close();
    await Promise.all(hosts.map((host) => host.dispose()));
    await relay?.stop();
    const pids = hosts.map((host) => host.pid);
    return { pids, alive: pids.filter(isAlive) };
  };
  const starts = await Promise.allSettled(
    names.map(async (name) => {
      const tap = relay?.tapFor();
      const url = tap?.url ?? options.relayUrl;
      if (url === undefined) throw new Error("no relay to dial");
      hosts.push(await startMeshHost({ name, relayUrl: url, tap }));
    }),
  );
  const failed = starts.find((start) => start.status === "rejected");
  if (failed !== undefined) {
    await dispose();
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
        feed.onEvent(() => {
          for (const wake of wakes) wake();
        });
        closers.push(
          () => feed.close(),
          () => connection.close(),
        );
        return connection;
      });
    cores.set(name, opened);
    return opened;
  };
  const until = async (what: string, check: () => Promise<boolean> | boolean, ms = WAIT_MS): Promise<void> => {
    const done = Promise.withResolvers<void>();
    let running = false;
    let again = false;
    const pass = async (): Promise<void> => {
      again = false;
      if (await check()) return done.resolve();
      if (again) return pass();
    };
    const evaluate = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await pass();
      } catch (error) {
        done.reject(error);
      } finally {
        running = false;
      }
    };
    const wake = (): void => void evaluate();
    wakes.add(wake);
    const unsubscribe = hosts.map((each) => each.onLog(wake));
    void evaluate();
    try {
      await within(done.promise, what, ms);
    } finally {
      wakes.delete(wake);
      for (const off of unsubscribe) off();
    }
  };
  const join = async (inviter: string, joiner: string): Promise<void> => {
    const from = host(inviter);
    const to = host(joiner);
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
    if (offer.exit !== 0 || link === undefined)
      throw new Error(`mesh pair on ${inviter} failed: ${offer.stderr}${offer.stdout}`);
    const joined = await to.cli("mesh", "join", link, "--yes", "--name", joiner);
    if (joined.exit !== 0) throw new Error(`mesh join on ${joiner} failed: ${joined.stderr}${joined.stdout}`);
  };
  return { relay, hosts, host, core, until, join, dispose };
}
