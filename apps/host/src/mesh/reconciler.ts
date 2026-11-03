import { HcRpcError, type MachineView } from "@doriface/protocol";
import type { Clock } from "./clock.ts";
import type { HcMachines } from "./hc-machines.ts";
import { fallbacks, type MeshMember, type MeshView } from "./upstream.ts";
import { meshHostOf, meshVia } from "./via.ts";

/** Section 8.1: a named STUCK state is retried when the view or `machine.list` changes, or every 10 minutes. */
export const STUCK_RETRY_MS = 600_000;

export type LineStatus =
  | { readonly state: "ok"; readonly note?: string }
  | { readonly state: "retrying"; readonly reason: string }
  | { readonly state: "stuck"; readonly reason: string };

export interface ReconcilerOptions {
  readonly machines: HcMachines;
  /** The absolute path of this doriface-host, and its state dir: together they pin the `via` form. */
  readonly program: string;
  readonly stateDir: string;
  readonly selfHostId: string;
  readonly clock: Clock;
  readonly log: (line: string) => void;
}

interface MeshEntry {
  readonly machine: MachineView;
  readonly hostId: string;
}

interface Attempt {
  readonly list: readonly MachineView[];
  readonly key: string;
  readonly via: string;
}

interface Stuck {
  readonly key: string;
  readonly until: number;
}

const DIFFERENT_CORE = "a different core answers there";
const kindOf = (error: unknown): string => (error instanceof HcRpcError ? error.kind : "unreachable");
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Keeps `machine.list` equal to the view (section 8.1): removes, then renames, then adds, concurrently. Every action
 * is derived from view minus list, so a second run with nothing changed calls nothing, and a crash re-derives it.
 */
export class Reconciler {
  readonly status = new Map<string, LineStatus>();
  readonly #options: ReconcilerOptions;
  readonly #stuck = new Map<string, Stuck>();
  #latest: MeshView | undefined;
  #running: Promise<void> = Promise.resolve();
  #queued = false;
  #cancelRetry: () => void = () => undefined;

  constructor(options: ReconcilerOptions) {
    this.#options = options;
  }

  /** Coalesces: while one run is busy, the next runs once with the newest view. */
  reconcile(view: MeshView): Promise<void> {
    this.#latest = view;
    if (this.#queued) return this.#running;
    this.#queued = true;
    this.#running = this.#running.then(() => this.#next());
    return this.#running;
  }

  idle(): Promise<void> {
    return this.#running;
  }

  /** Presence of a member whose line is not connected: herdr dials it now (`machine.connect`). */
  async presence(member: MeshMember): Promise<void> {
    const entry = (await this.#entries()).find((candidate) => candidate.hostId === member.hostId);
    if (entry === undefined || entry.machine.state === "connected") return;
    try {
      await this.#options.machines.connect(entry.machine.name);
    } catch (error) {
      this.status.set(member.hostId, { state: "retrying", reason: messageOf(error) });
    }
  }

  async #next(): Promise<void> {
    this.#queued = false;
    const latest = this.#latest;
    if (latest === undefined) return;
    try {
      await this.#run(latest);
    } catch (error) {
      this.#options.log(`mesh: reconcile failed: ${messageOf(error)}`);
    }
  }

  async #entries(): Promise<readonly MeshEntry[]> {
    const { program, stateDir } = this.#options;
    const entries: MeshEntry[] = [];
    for (const machine of await this.#options.machines.list()) {
      const hostId = machine.via === true ? meshHostOf(machine.target, program, stateDir) : undefined;
      if (hostId !== undefined) entries.push({ machine, hostId });
    }
    return entries;
  }

  async #run(view: MeshView): Promise<void> {
    const { machines, selfHostId } = this.#options;
    const desired = new Map(view.members.filter((m) => m.hostId !== selfHostId).map((m) => [m.hostId, m]));
    const entries = await this.#entries();
    const stale = entries.filter(
      (entry) => !desired.has(entry.hostId) || (entry.machine.why ?? "").includes(DIFFERENT_CORE),
    );
    await Promise.all(
      stale.map(async (entry) => {
        await machines.rm(entry.machine.name);
        this.#options.log(`mesh: removed machine ${entry.machine.name}`);
      }),
    );
    const kept = entries.filter((entry) => !stale.includes(entry));
    await Promise.all(kept.map((entry) => this.#rename(entry, desired.get(entry.hostId))));
    const list = await machines.list();
    const missing = [...desired.values()].filter((member) => !kept.some((entry) => entry.hostId === member.hostId));
    const key = JSON.stringify([view.members.map((m) => [m.hostId, m.name]), list.map((m) => m.name).toSorted()]);
    await Promise.all(missing.map((member) => this.#add(member, list, key)));
    this.#armRetry(view);
  }

  async #rename(entry: MeshEntry, member: MeshMember | undefined): Promise<void> {
    if (member === undefined) return;
    const allowed = [member.name, ...fallbacks(member.name, member.hostId)];
    if (allowed.includes(entry.machine.name)) return;
    await this.#renameTo(entry.machine.name, allowed);
  }

  async #renameTo(current: string, names: readonly string[]): Promise<void> {
    const [name, ...rest] = names;
    if (name === undefined) return;
    try {
      await this.#options.machines.rename(current, name);
      this.#options.log(`mesh: renamed machine ${current} to ${name}`);
    } catch (error) {
      if (kindOf(error) !== "name_taken") throw error;
      await this.#renameTo(current, rest);
    }
  }

  async #add(member: MeshMember, list: readonly MachineView[], key: string): Promise<void> {
    const stuck = this.#stuck.get(member.hostId);
    if (stuck !== undefined && stuck.key === key && this.#options.clock.now() < stuck.until) return;
    this.#stuck.delete(member.hostId);
    const via = meshVia(this.#options.program, this.#options.stateDir, member.hostId);
    await this.#addAs(member, { list, key, via }, [member.name, ...fallbacks(member.name, member.hostId)]);
  }

  /** Tries each name in turn: `name_taken` moves to the next fallback; every other refusal is a named state. */
  async #addAs(member: MeshMember, attempt: Attempt, names: readonly string[]): Promise<void> {
    const [name, ...rest] = names;
    if (name === undefined) {
      return this.#stick(member, attempt.key, `name_taken: "${member.name}" and its fallbacks are used on this core`);
    }
    try {
      await this.#options.machines.add(name, attempt.via);
      this.status.set(member.hostId, { state: "ok" });
    } catch (error) {
      const kind = kindOf(error);
      if (kind === "name_taken") return this.#addAs(member, attempt, rest);
      if (kind === "invalid_params") {
        return this.#stick(member, attempt.key, `invalid_name: herdr refused "${name}": ${messageOf(error)}`);
      }
      if (kind === "already_added") return this.#migrate(member, attempt, name);
      this.status.set(member.hostId, { state: "retrying", reason: `${kind}: ${messageOf(error)}` });
    }
  }

  /** The member's core is already here under a #30 `doriface-host connect` entry: replace it with the mesh line. */
  async #migrate(member: MeshMember, attempt: Attempt, name: string): Promise<void> {
    const { program, stateDir, machines } = this.#options;
    const old = attempt.list.find((machine) => machine.id === member.hcId);
    if (old === undefined || meshHostOf(old.target, program, stateDir) !== undefined) {
      return this.#stick(member, attempt.key, `copied core: ${member.name}'s core is another member's`);
    }
    await machines.rm(old.name);
    await machines.add(name, attempt.via);
    const note = `replaced machine "${old.name}" (doriface-host connect) with the mesh line`;
    this.status.set(member.hostId, { state: "ok", note });
    this.#options.log(`mesh: ${note}`);
  }

  #stick(member: MeshMember, key: string, reason: string): void {
    this.#stuck.set(member.hostId, { key, until: this.#options.clock.now() + STUCK_RETRY_MS });
    this.status.set(member.hostId, { state: "stuck", reason });
    this.#options.log(`mesh: STUCK ${member.name}: ${reason}`);
  }

  #armRetry(view: MeshView): void {
    this.#cancelRetry();
    if (this.#stuck.size === 0) return;
    this.#cancelRetry = this.#options.clock.after(STUCK_RETRY_MS, () => void this.reconcile(this.#latest ?? view));
  }
}
