import { HcRpcError, type MachineView, type MeshReplacedMachine, replacedMachineText } from "@doriface/protocol";
import type { Clock } from "./clock.ts";
import type { HcMachines } from "./hc-machines.ts";
import { fallbacks } from "@doriface/mesh";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";
import { machinesOf } from "./mesh-view.ts";
import { type AddReservation, BUDGET_REFUSAL } from "./line-grants.ts";
import { meshHostOf, meshVia } from "./via.ts";
import { renameToMeshName } from "./line-names.ts";
import { replacedOf } from "./replaced.ts";
import { ProbeBackoff } from "./probe-backoff.ts";
import { migrate } from "./migration.ts";

/** Section 8.1: a named STUCK state is retried when the view or `machine.list` changes, or every 10 minutes. */
export const STUCK_RETRY_MS = 600_000;

export type LineStatus =
  | { readonly state: "ok"; readonly replaced?: MeshReplacedMachine }
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
  /**
   * Takes both relay upgrades of a `machine.add` ahead (the running host's LineGrants.reserveAdd), so an add starts
   * only when the dial budget has room for herdr's probe and the line together (section 8.2, #106).
   */
  readonly reserve?: (hostId: string) => Promise<AddReservation>;
}

export interface MeshEntry {
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
  /** Unreachable, hc_missing, incompatible; a line refused for the dial budget is re-added by the policy's due. */
  readonly #retries: ProbeBackoff;
  /** Newly admitted members whose add waits for the 0-5 s jitter (section 8.2). */
  readonly #held = new Set<string>();
  #latest: MeshView | undefined;
  #running: Promise<void> = Promise.resolve();
  #queued = false;
  #cancelRetry: () => void = () => undefined;

  #listed: readonly MeshEntry[] = [];

  constructor(options: ReconcilerOptions) {
    this.#options = options;
    this.#retries = new ProbeBackoff(options.clock, () => {
      if (this.#latest !== undefined) void this.reconcile(this.#latest);
    });
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

  /** The names of this host's mesh machines still in its core; rejects when herdr does not answer. */
  async remaining(): Promise<readonly string[]> {
    return (await this.#entries()).map((entry) => entry.machine.name);
  }

  /** The host is stopping: no retry fires after this. */
  stop(): void {
    this.#cancelRetry();
    this.#retries.clearExcept();
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

  /** The mesh machines herdr listed at the end of this host's last reconcile, for status (which cannot wait on herdr). */
  lines(): readonly MeshEntry[] {
    return this.#listed;
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
    // A client is not a machine to add: it is reached, never added (design of #942, section 6).
    const inView = machinesOf(view).some((m) => m.hostId === selfHostId);
    const others = inView ? machinesOf(view).filter((m) => m.hostId !== selfHostId) : [];
    const desired = new Map(others.map((m) => [m.hostId, m]));
    this.#retries.clearExcept((hostId) => desired.has(hostId));
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
    await Promise.all(
      kept.map((entry) => renameToMeshName(machines, this.#options.log, entry, desired.get(entry.hostId))),
    );
    const list = await machines.list();
    const missing = [...desired.values()].filter(
      (member) => !this.#held.has(member.hostId) && !kept.some((entry) => entry.hostId === member.hostId),
    );
    const key = JSON.stringify([view.members.map((m) => [m.hostId, m.name]), list.map((m) => m.name).toSorted()]);
    await Promise.all(missing.map((member) => this.#add(member, list, key)));
    this.#listed = await this.#entries();
    this.#armRetry(view);
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
      await this.#reservedAdd(member, name, attempt.via);
      this.#retries.clear(member.hostId);
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
      if (!messageOf(error).includes(BUDGET_REFUSAL)) this.#retries.later(member.hostId);
    }
  }

  /**
   * herdr answered `already_added`: it dialed the mesh line and found the member's core already here, under an entry
   * added over ssh or with a via. That entry is removed and the line added in its place, under the member's name first:
   * herdr checks a name before it dials, so the line could only reach `already_added` under a name the old entry did not
   * hold, and that entry may hold the member's own name. The machine keeps its core id, so its documents, terminals and
   * the tabs keyed by that id carry over. A second `already_added` means another entry still holds the core.
   */
  async #migrate(member: MemberEntry, attempt: Attempt, tried: string): Promise<void> {
    const { program, stateDir, machines, reserve, log } = this.#options;
    const old = attempt.list.find((machine) => machine.id === member.hcId);
    const copied = `copied core: ${member.name}'s core is another member's`;
    if (old === undefined || meshHostOf(old.target, program, stateDir) !== undefined) {
      return this.#stick(member, attempt.key, copied);
    }
    const names = [member.name, ...fallbacks(member.name, member.hostId)];
    const parts = { machines, log, reserve: reserve === undefined ? undefined : () => reserve(member.hostId) };
    const done = await migrate(parts, old, names, attempt.via);
    if (done.kind === "copied") return this.#stick(member, attempt.key, copied);
    if (done.kind === "added") {
      this.#retries.clear(member.hostId);
      const replaced = replacedOf(old);
      this.status.set(member.hostId, { state: "ok", replaced });
      return log(`mesh: added machine ${done.name}, ${replacedMachineText(replaced)}`);
    }
    this.status.set(member.hostId, { state: "retrying", reason: done.reason });
    log(`mesh: replacing machine ${old.name} with ${tried}'s mesh line is retried: ${done.reason}`);
    if (!done.reason.includes(BUDGET_REFUSAL)) this.#retries.later(member.hostId);
  }

  /** `machine.add` once both of its upgrades are reserved; a refused reservation throws as herdr's refusal would. */
  async #reservedAdd(member: MemberEntry, name: string, via: string): Promise<void> {
    const reserved = await this.#options.reserve?.(member.hostId);
    if (reserved !== undefined && !reserved.ok) {
      throw new HcRpcError({
        code: -32000,
        message: `doriface-host connect: ${reserved.reason}`,
        data: { kind: "unreachable" },
      });
    }
    try {
      await this.#options.machines.add(name, via);
    } catch (error) {
      if (reserved?.ok === true) reserved.failed();
      throw error;
    }
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
