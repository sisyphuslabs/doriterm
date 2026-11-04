import { HcRpcError, type MachineView } from "@doriface/protocol";
import type { Clock } from "./clock.ts";
import { DIAL_LIMITS } from "./dial-policy.ts";
import type { HcMachines } from "./hc-machines.ts";
import { fallbacks } from "@doriface/mesh";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";
import { BUDGET_REFUSAL } from "./line-grants.ts";
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

interface Retry {
  readonly attempts: number;
  readonly cancel: () => void;
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
  /** Members whose add failed with herdr's retryable kinds, on section 8.2's probe backoff. */
  readonly #retries = new Map<string, Retry>();
  /** Newly admitted members whose add waits for the 0-5 s jitter (section 8.2). */
  readonly #held = new Set<string>();
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

  /** The host is stopping: no retry fires after this. */
  stop(): void {
    this.#cancelRetry();
    for (const hostId of this.#retries.keys()) this.#retried(hostId);
    this.#latest = undefined;
  }

  holdAdd(hostId: string): void {
    this.#held.add(hostId);
  }

  releaseAdd(hostId: string): Promise<void> {
    this.#held.delete(hostId);
    return this.#latest === undefined ? this.#running : this.reconcile(this.#latest);
  }

  /**
   * Presence of a member: herdr dials a line that is not connected now (`machine.connect`), and a member with no line
   * yet (its add failed while it was offline) is added now.
   */
  async presence(member: MemberEntry): Promise<void> {
    let entries: readonly MeshEntry[];
    try {
      entries = await this.#entries();
    } catch (error) {
      return this.#options.log(`mesh: presence of ${member.name}: herdr did not answer: ${messageOf(error)}`);
    }
    const entry = entries.find((candidate) => candidate.hostId === member.hostId);
    if (entry === undefined) {
      if (this.#latest?.members.some((candidate) => candidate.hostId === member.hostId)) {
        await this.reconcile(this.#latest);
      }
      return;
    }
    if (entry.machine.state === "connected" || entry.machine.state === "connecting") return;
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
    // Section 6.4: a host its own view does not list (revoked, over the cap) keeps no mesh machine until it is again.
    const inView = view.members.some((m) => m.hostId === selfHostId);
    const others = inView ? view.members.filter((m) => m.hostId !== selfHostId) : [];
    const desired = new Map(others.map((m) => [m.hostId, m]));
    for (const hostId of this.#retries.keys()) if (!desired.has(hostId)) this.#retried(hostId);
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
    const missing = [...desired.values()].filter(
      (member) => !this.#held.has(member.hostId) && !kept.some((entry) => entry.hostId === member.hostId),
    );
    const key = JSON.stringify([view.members.map((m) => [m.hostId, m.name]), list.map((m) => m.name).toSorted()]);
    await Promise.all(missing.map((member) => this.#add(member, list, key)));
    this.#armRetry(view);
  }

  async #rename(entry: MeshEntry, member: MemberEntry | undefined): Promise<void> {
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

  async #add(member: MemberEntry, list: readonly MachineView[], key: string): Promise<void> {
    const stuck = this.#stuck.get(member.hostId);
    if (stuck !== undefined && stuck.key === key && this.#options.clock.now() < stuck.until) return;
    this.#stuck.delete(member.hostId);
    let via: string;
    try {
      via = meshVia(this.#options.program, this.#options.stateDir, member.hostId);
    } catch (error) {
      return this.#stick(member, key, `invalid_host: ${messageOf(error)}`);
    }
    await this.#addAs(member, { list, key, via }, [member.name, ...fallbacks(member.name, member.hostId)]);
  }

  /** Tries each name in turn: `name_taken` moves to the next fallback; every other refusal is a named state. */
  async #addAs(member: MemberEntry, attempt: Attempt, names: readonly string[]): Promise<void> {
    const [name, ...rest] = names;
    if (name === undefined) {
      return this.#stick(member, attempt.key, `name_taken: "${member.name}" and its fallbacks are used on this core`);
    }
    try {
      await this.#options.machines.add(name, attempt.via);
      this.#retried(member.hostId);
      this.status.set(member.hostId, { state: "ok" });
      this.#options.log(`mesh: added machine ${name}`);
    } catch (error) {
      const kind = kindOf(error);
      if (kind === "name_taken") return this.#addAs(member, attempt, rest);
      if (kind === "invalid_params") {
        return this.#stick(member, attempt.key, `invalid_name: herdr refused "${name}": ${messageOf(error)}`);
      }
      if (kind === "already_added") return this.#migrate(member, attempt, name);
      this.status.set(member.hostId, { state: "retrying", reason: `${kind}: ${messageOf(error)}` });
      this.#options.log(`mesh: adding machine ${name} failed (${kind}): ${messageOf(error)}; retrying`);
      this.#retryLater(member.hostId, messageOf(error).includes(BUDGET_REFUSAL));
    }
  }

  /**
   * Unreachable, hc_missing, incompatible: retried 30 s later, doubling to 5 minutes, and at once on presence. A line
   * refused for the dial budget does not double the wait: the policy's "budget" due re-adds it once the window frees.
   */
  #retryLater(hostId: string, forBudget: boolean): void {
    const previous = this.#retries.get(hostId)?.attempts ?? 0;
    const attempts = forBudget ? Math.max(previous, 1) : previous + 1;
    this.#retries.get(hostId)?.cancel();
    const wait = Math.min(DIAL_LIMITS.probeFirstMs * 2 ** (attempts - 1), DIAL_LIMITS.probeMaxMs);
    const cancel = this.#options.clock.after(wait, () => {
      if (this.#latest !== undefined) void this.reconcile(this.#latest);
    });
    this.#retries.set(hostId, { attempts, cancel });
  }

  #retried(hostId: string): void {
    this.#retries.get(hostId)?.cancel();
    this.#retries.delete(hostId);
  }

  /** The member's core is already here under a #30 `doriface-host connect` entry: replace it with the mesh line. */
  async #migrate(member: MemberEntry, attempt: Attempt, name: string): Promise<void> {
    const { program, stateDir, machines } = this.#options;
    const old = attempt.list.find((machine) => machine.id === member.hcId);
    if (old === undefined || meshHostOf(old.target, program, stateDir) !== undefined) {
      return this.#stick(member, attempt.key, `copied core: ${member.name}'s core is another member's`);
    }
    await machines.rm(old.name);
    await machines.add(name, attempt.via);
    this.#retried(member.hostId);
    const note = `replaced machine "${old.name}" (doriface-host connect) with the mesh line`;
    this.status.set(member.hostId, { state: "ok", note });
    this.#options.log(`mesh: ${note}`);
  }

  #stick(member: MemberEntry, key: string, reason: string): void {
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
