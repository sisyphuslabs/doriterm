import type { MachineView, Terminal } from "@doriface/protocol";
import { byName, idOfMachine, machineOf, type Session } from "./model.ts";

export interface MachineEntry {
  /** Unique even when an added machine is named like this one. */
  readonly id: string;
  /** The machine's permanent core id (hc's `machine.list` id; this core's own for this machine): a rename keeps it. */
  readonly core: string;
  readonly name: string;
  /** The machine this client is connected to; its terminals have bare addresses. */
  readonly local: boolean;
  readonly state: string;
  /** Its first live terminal, opened when the machine is picked. Its row counts tabs, not terminals (`machineGroups`). */
  readonly first: string | undefined;
}

/** hc's states in the sidebar's words; "offline" is what the Machines screen and an offline pane say. */
const LABELS: Readonly<Record<string, string>> = { needs_login: "needs login", unreachable: "offline" };

export const stateLabel = (state: string): string => LABELS[state] ?? state;

/** Only this machine is listed: the section ends in an Add a machine row instead of a header action. */
export const onlyThisMachine = (entries: readonly MachineEntry[]): boolean => entries.every((machine) => machine.local);

function entry(core: string, name: string, local: boolean, state: string, terminals: readonly Session[]): MachineEntry {
  const machine = local ? undefined : name;
  const first = terminals.find((t) => t.state === "live" && t.offline !== true && machineOf(t.address) === machine);
  return { id: idOfMachine(machine), core, name, local, state, first: first?.address };
}

/** The core the client is connected to, as its `hello` names it. */
export interface ThisCore {
  readonly id: string;
  readonly name: string;
}

/**
 * The added machines by name. hc lists them in the order this host learned of them, which in a mesh differs from host
 * to host and moves when a machine reconnects, so every list (sidebar, notices, phone, Settings) reads them sorted.
 */
export const orderMachines = (machines: readonly MachineView[]): MachineView[] =>
  machines.toSorted((a, b) => byName.compare(a.name, b.name));

/**
 * Every machine in the default order: by name, the core this page happens to reach included. Which host carries the
 * traffic is not the person's arrangement, so it is never put first (#2531); the person's own order is applied on top.
 */
export function machineEntries(
  core: ThisCore,
  machines: readonly MachineView[],
  terminals: readonly Session[],
): MachineEntry[] {
  return [
    entry(core.id, core.name, true, "connected", terminals),
    ...machines.map((machine) => entry(machine.id, machine.name, false, machine.state, terminals)),
  ].toSorted((a, b) => byName.compare(a.name, b.name));
}

/**
 * Which added machines have live terminals: it changes when a machine's terminals appear, finish or go, and each
 * change triggers a machine.list read. It does not by itself catch a machine going offline: hc 0.1.17 marks that
 * machine's terminals finished before it updates the machine's state, so the read it triggers can still say
 * connected. The periodic read in useMachines (MACHINE_REFRESH_MS) is what brings the unreachable state in.
 */
export function machineKey(terminals: readonly Terminal[]): string {
  const live = terminals.filter((terminal) => terminal.state === "live");
  const names = new Set(live.flatMap((terminal) => machineOf(terminal.address) ?? []));
  return [...names].toSorted().join(" ");
}
