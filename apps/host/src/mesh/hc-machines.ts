import { type ByteLink, HcConnection, LinkClosedError } from "@doriface/client";
import type { Machine, MachineView } from "@doriface/protocol";
import type { Subprocess } from "bun";

/** The herdr-core calls the reconciler makes (`api.rs` `machine_*`). Failures throw `HcRpcError` with herdr's kind. */
export interface HcMachines {
  list(): Promise<readonly MachineView[]>;
  add(name: string, via: string): Promise<Machine>;
  rm(name: string): Promise<void>;
  rename(name: string, newName: string): Promise<void>;
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
  };
}

/** A `hc connect` child's stdio as the client's ByteLink. */
class ChildLink implements ByteLink {
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
  close(): void;
}

export interface HcTarget {
  readonly hc: string;
  readonly session?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** `hc connect` to a core as a byte link. */
export function spawnHcLink(target: HcTarget): ByteLink {
  const session = target.session === undefined ? [] : ["--session", target.session];
  const child = Bun.spawn([target.hc, "connect", ...session], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: target.env ?? process.env,
  });
  return new ChildLink(child);
}

/** Opens a control connection to this host's own core, as the gateway's pipes do. */
export async function openHcControl(target: HcTarget): Promise<HcControl> {
  const connection = await HcConnection.open(spawnHcLink(target));
  return { machines: hcMachines(connection), coreId: connection.hello.core.id, close: () => connection.close() };
}
