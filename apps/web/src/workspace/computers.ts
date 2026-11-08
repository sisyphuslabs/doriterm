import type { MemberEntry } from "../connection/mesh-connections.ts";
import type { MachineEntry } from "./machines.ts";

/** One computer the phone can use, whichever mechanism made it reachable (#1296). */
export interface Computer {
  /** Stable across a rename: the core id when the roster knows one, else the paired host id. */
  readonly id: string;
  readonly name: string;
  /** "this" is the machine the app is attached to; the others are reachable computers. */
  readonly state: "this" | "connected" | "offline";
  /** Why it is offline, when it is: the roster's own words, never invented here. */
  readonly reason: string | undefined;
  /** True when this app holds its own pairing to it, which is what makes it switchable. */
  readonly paired: boolean;
}

const pairedState = (phase: MemberEntry["state"]["phase"]): Computer["state"] =>
  phase === "open" ? "connected" : "offline";

/**
 * Every computer this phone can use, in one list, from both places a computer can come from (#1296).
 *
 * The roster the connected host reports (`MachineEntry`) and the machines this app paired itself
 * (`MemberEntry`) are two mechanisms, not two kinds of thing: a person picking a computer should never have to know
 * which one made it reachable. The roster wins for a machine both know, because it carries the live state the host
 * actually measured; a machine only this app paired still gets a row, marked paired so it can be switched to.
 */
export function unifyComputers(
  roster: readonly MachineEntry[],
  paired: readonly MemberEntry[],
  activeHostId: string,
): Computer[] {
  const computers = new Map<string, Computer>();
  for (const machine of roster) {
    const state: Computer["state"] = machine.local ? "this" : machine.state === "unreachable" ? "offline" : "connected";
    computers.set(machine.core, {
      id: machine.core,
      name: machine.name,
      state,
      reason: state === "offline" ? machine.state : undefined,
      paired: false,
    });
  }
  for (const entry of paired) {
    const known = [...computers.values()].find((computer) => computer.id === entry.target.hostId);
    if (known !== undefined) {
      computers.set(known.id, { ...known, paired: true });
      continue;
    }
    const name = entry.target.hostName === "" ? entry.target.hostId : entry.target.hostName;
    computers.set(entry.target.hostId, {
      id: entry.target.hostId,
      name,
      state: entry.target.hostId === activeHostId ? "this" : pairedState(entry.state.phase),
      reason: undefined,
      paired: true,
    });
  }
  return [...computers.values()];
}
