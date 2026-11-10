import { type ByteLink, HcConnection, LinkClosedError } from "@doriface/client";
import type { Machine, MachineView } from "@doriface/protocol";
import type { Subprocess } from "bun";

/** The herdr-core calls the reconciler makes (`api.rs` `machine_*`). Failures throw `HcRpcError` with herdr's kind. */
export interface HcMachines {
  list(): Promise<readonly MachineView[]>;
  add(name: string, via: string): Promise<Machine>;
  rm(name: string): Promise<void>;
  rename(name: string, newName: string): Promise<void>;
  /** Adds `machine` back as it was listed: its name, session and how it is reached (ssh target or via). */
  restore(machine: MachineView): Promise<void>;
  connect(name: string): Promise<MachineView>;
}

/** `machine.add` waits for herdr's own 20 s hello probe through the line. */
const CALL_TIMEOUT_MS = 30_000;

export function hcMachines(connection: HcConnection): HcMachines {
  const options = { timeoutMs: CALL_TIMEOUT_MS };
  return {
    list: async () => (await connection.call("machine.list", {}, options)).machines,
    add: (name, via) => connection.call("machine.add", { name, via }, options),
    rm: async (machine) => void (await connection.call("machine.rm", { machine }, options)),
    rename: async (machine, newName) =>
      void (await connection.call("machine.rename", { machine, new_name: newName }, options)),
    connect: (machine) => connection.call("machine.connect", { machine }, options),
    restore: async (machine) => {
      const reach = machine.via === true ? { via: machine.target } : { target: machine.target };
      const extra = { session: machine.session ?? null, temporary: machine.temporary ?? false };
      await connection.call("machine.add", { name: machine.name, ...reach, ...extra }, options);
    },
  };
}

/** A link to a child process, which can be ended by force when closing its stdin is not enough. */
export interface ChildByteLink extends ByteLink {
  readonly pid: number;
  kill(signal: "SIGKILL"): void;
}

/** A link that may be a child process (a test's link is not), so a stop that closing it did not end can kill it. */
export type KillableLink = ByteLink & Partial<Pick<ChildByteLink, "pid" | "kill">>;

/** A `hc connect` child's stdio as the client's ByteLink. */
class ChildLink implements ChildByteLink {
  readonly #child: Subprocess<"pipe", "pipe", "inherit">;
  readonly #data = new Set<(bytes: Uint8Array) => void>();
  readonly #close = new Set<(error: Error | undefined) => void>();
  #open = true;

  constructor(child: Subprocess<"pipe", "pipe", "inherit">) {
    this.#child = child;
    void this.#pump();
  }

  send(bytes: Uint8Array): void {
    if (!this.#open) throw new LinkClosedError("hc connect stdin is closed");
    this.#child.stdin.write(bytes);
    void this.#child.stdin.flush();
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onClose(listener: (error: Error | undefined) => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    void this.#child.stdin.end();
  }

  get pid(): number {
    return this.#child.pid;
  }

  kill(signal: "SIGKILL"): void {
    this.#child.kill(signal);
  }

  async #pump(): Promise<void> {
    for await (const chunk of this.#child.stdout) for (const listener of this.#data) listener(chunk);
    this.#open = false;
    const status = await this.#child.exited;
    const error = status === 0 ? undefined : new LinkClosedError(`hc connect exited with status ${status}`);
    for (const listener of this.#close) listener(error);
  }
}

export interface HcControl {
  readonly machines: HcMachines;
  readonly coreId: string;
  /**
   * Ends this control's `hc connect` child and settles once it has exited: a launch stopped this way can start no core
   * afterwards. One that ignores a closed stdin is killed after the stop's grace.
   */
  stop(): Promise<void>;
  /** Kills the child if it has not exited (one that ignores a closed stdin); the pids it killed. */
  kill(): readonly number[];
}

/** How long a stopped launch has to exit on a closed stdin before it is killed: `hc connect` exits at once. */
export const HC_STOP_GRACE_MS = 2_000;

/** The options a control's handshake takes: stopping the host ends a hello the core never answers. */
export interface OpenHcControlOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface HcTarget {
  readonly hc: string;
  readonly session?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** How long a connect's hello may go unanswered before that connection fails; HcConnection's 10 s when unset. */
  readonly handshakeTimeoutMs?: number | undefined;
}

/** The handshake deadline `core` names, as HcConnection.open takes it. */
export const handshakeOf = (core: HcTarget): { readonly handshakeTimeoutMs?: number } =>
  core.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: core.handshakeTimeoutMs };

/**
 * Opens a connection on this host's own core with the hello deadline `core` names. Every writer the host starts on its
 * core opens through here, so a configured deadline reaches each of them (#1011).
 */
export const openOnCore = (link: ByteLink, core: HcTarget, options: OpenHcControlOptions = {}): Promise<HcConnection> =>
  HcConnection.open(link, {
    ...handshakeOf(core),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

/** `hc connect` to a core as a byte link. */
export function spawnHcLink(target: HcTarget): ChildByteLink {
  const session = target.session === undefined ? [] : ["--session", target.session];
  const child = Bun.spawn([target.hc, "connect", ...session], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: target.env ?? process.env,
  });
  return new ChildLink(child);
}

/**
 * Opens a control connection to this host's own core, as the gateway's pipes do, over one `hc connect` child this
 * control owns: every `hc` call starts its session's core when none runs, so a launch that outlived its owner would
 * start the core again after the host stopped (#441). A launch whose handshake fails is ended here, not left behind.
 */
export async function openHcControl(target: HcTarget, options: OpenHcControlOptions = {}): Promise<HcControl> {
  const link = spawnHcLink(target);
  let running = true;
  const exited = new Promise<void>((resolve) =>
    link.onClose(() => {
      running = false;
      resolve();
    }),
  );
  const stop = async (): Promise<void> => {
    link.close();
    const grace = setTimeout(() => {
      if (running) link.kill("SIGKILL");
    }, HC_STOP_GRACE_MS);
    try {
      await exited;
    } finally {
      clearTimeout(grace);
    }
  };
  let connection: HcConnection;
  try {
    connection = await openOnCore(link, target, options);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    machines: hcMachines(connection),
    coreId: connection.hello.core.id,
    stop: async () => {
      connection.close();
      await stop();
    },
    kill: () => {
      if (!running) return [];
      link.kill("SIGKILL");
      return [link.pid];
    },
  };
}
