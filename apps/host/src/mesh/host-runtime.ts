import { HcConnectionClosedError } from "@doriface/client";
import type { ByteLink, HostIdentity } from "@doriface/crypto";
import type { Signed } from "@doriface/mesh";
import { join } from "node:path";
import type { MeshStore } from "../state/mesh.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { Clock, Random } from "./clock.ts";
import { type HcControl, type HcMachines, type HcTarget, openHcControl } from "./hc-machines.ts";
import type { LineLink } from "./lines.ts";
import { LINE_SOCKET, type LineSocket, listenLineSocket } from "./line-socket.ts";
import { MeshRuntime } from "./runtime.ts";

export interface HostRuntimeOptions {
  readonly identity: HostIdentity;
  readonly mesh: MeshStore;
  readonly meshId: string;
  /** This host's own herdr core, whose `machine.list` the reconciler keeps equal to the view. */
  readonly hc: HcTarget;
  readonly stateDir: string;
  readonly program: string;
  readonly clock: Clock;
  readonly random: Random;
  readonly log: (line: string) => void;
  readonly dialSync: (member: MemberEntry) => Promise<LineLink>;
  readonly dialLine: (member: MemberEntry) => Promise<ByteLink>;
  /** Records sync stored, so the host does not push them onwards as its own. */
  readonly merged: (records: readonly Signed[]) => void;
}

export interface HostRuntime {
  readonly runtime: MeshRuntime;
  /** Starts sync and the reconciler: a joiner's kept session is attached first, so nothing dials past it. */
  start(): void;
  stop(): Promise<void>;
}

/** `machine.*` on this host's core over one control connection, opened on first use and again after a failure. */
function lazyMachines(target: HcTarget): { readonly machines: HcMachines; close(): Promise<void> } {
  let control: Promise<HcControl> | undefined;
  const open = (): Promise<HcControl> => {
    const opening = (control ??= openHcControl(target));
    opening.catch(() => {
      if (control === opening) control = undefined;
    });
    return opening;
  };
  /** A connection that closed (hc restarted) is opened again by the next call. */
  const call = async <T>(run: (machines: HcMachines) => Promise<T>): Promise<T> => {
    const opening = open();
    const opened = await opening;
    try {
      return await run(opened.machines);
    } catch (error) {
      if (error instanceof HcConnectionClosedError && control === opening) control = undefined;
      throw error;
    }
  };
  const machines: HcMachines = {
    list: () => call((m) => m.list()),
    add: (name, via) => call((m) => m.add(name, via)),
    rm: (name) => call((m) => m.rm(name)),
    rename: (name, newName) => call((m) => m.rename(name, newName)),
    connect: (name) => call((m) => m.connect(name)),
  };
  const close = async (): Promise<void> => {
    const opened = await control?.catch(() => undefined);
    opened?.close();
  };
  return { machines, close };
}

/**
 * The mesh of a running host (sections 5, 7.2 and 8): sync, the reconciler over this host's own core, and
 * `line.sock` for `doriface-host connect --mesh`. Every piece stops with the host.
 */
export function startHostRuntime(options: HostRuntimeOptions): HostRuntime {
  const { log } = options;
  const core = lazyMachines(options.hc);
  const runtime = new MeshRuntime({
    store: options.mesh,
    identity: options.identity,
    meshId: options.meshId,
    clock: options.clock,
    random: options.random,
    log,
    dial: options.dialSync,
    dialLine: options.dialLine,
    machines: core.machines,
    program: options.program,
    stateDir: options.stateDir,
    onView: (_view, result) => options.merged(result.added),
  });
  const socket: Promise<LineSocket | undefined> = listenLineSocket({
    path: join(options.stateDir, LINE_SOCKET),
    grant: (hostId) => runtime.lines.grant(hostId),
    log,
  }).catch((error: unknown) => {
    log(`mesh: line.sock not started: ${String(error)}`);
    return undefined;
  });
  return {
    runtime,
    start: () => {
      runtime.start().catch((error: unknown) => log(`mesh: the first reconcile failed: ${String(error)}`));
      runtime.gossip.ackAdmission();
      runtime.gossip.uplinkReturned(Number.POSITIVE_INFINITY);
    },
    stop: async () => {
      runtime.stop();
      (await socket)?.stop();
      await core.close();
    },
  };
}
