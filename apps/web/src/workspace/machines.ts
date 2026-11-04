import type { MachineView, Terminal } from "@doriface/protocol";
import { idOfMachine, machineOf, type Session } from "./model.ts";

export interface MachineEntry {
  /** Unique even when an added machine is named like this one. */
  readonly id: string;
  readonly name: string;
  /** The machine this client is connected to; its terminals have bare addresses. */
  readonly local: boolean;
  readonly state: string;
  readonly live: number;
  /** Its first live terminal, opened when the machine is picked. */
  readonly first: string | undefined;
}

/** hc's states in the sidebar's words; "offline" is what Settings > Machines and an offline pane say. */
const LABELS: Readonly<Record<string, string>> = { needs_login: "needs login", unreachable: "offline" };

export const stateLabel = (state: string): string => LABELS[state] ?? state;

/**
 * The section shows whenever there is a machine to list, this one included, so a person with one machine still
 * sees where added machines go and how to add one; and when listing failed, so they can see why.
 */
export const showMachines = (entries: readonly MachineEntry[], listError: string | undefined): boolean =>
  entries.length > 0 || listError !== undefined;

/** Only this machine is listed: the section ends in an Add a machine row instead of a header action. */
export const onlyThisMachine = (entries: readonly MachineEntry[]): boolean => entries.every((machine) => machine.local);

function entry(name: string, local: boolean, state: string, terminals: readonly Session[]): MachineEntry {
  const live = terminals.filter((t) => t.state === "live" && t.offline !== true);
  const own = live.filter((t) => machineOf(t.address) === (local ? undefined : name));
  return { id: idOfMachine(local ? undefined : name), name, local, state, live: own.length, first: own[0]?.address };
}

const byName = new Intl.Collator(undefined, { numeric: true });

/**
 * This machine first, then the added ones by name: hc lists them in the order this host learned of them, which in a
 * mesh differs from host to host and moves when a machine reconnects.
 */
export function machineEntries(
  localName: string,
  machines: readonly MachineView[],
  terminals: readonly Session[],
): MachineEntry[] {
  return [
    entry(localName, true, "connected", terminals),
    ...machines
      .toSorted((a, b) => byName.compare(a.name, b.name))
      .map((machine) => entry(machine.name, false, machine.state, terminals)),
  ];
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
