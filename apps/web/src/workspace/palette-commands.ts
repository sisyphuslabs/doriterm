import type { Terminal } from "@doriface/protocol";
import type { Command } from "@doriface/ui";
import { ACTION_BY_ID } from "../keys/actions.ts";
import type { Keymap } from "../keys/defaults.ts";
import { triggersFor } from "../keys/keymap.ts";
import { triggerKeys, type Platform } from "../keys/trigger.ts";
import type { AgentStatus } from "@doriface/ui";
import { agentStatus } from "./attention.ts";
import { type ListedSpace, machineOf, spaceOfAddress, terminalTitle } from "./model.ts";
import { agentWhere } from "./palette-where.ts";
import type { ShellAction } from "./shell-actions.ts";

const AGENT = "agent:";
/** The palette leads with the agent that needs you, as the sidebar sections do. */
const URGENCY: Readonly<Record<AgentStatus, number>> = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };
const HOST = "host:";
/** The palette's General group: the app's own help and settings, after the hosts. */
const GENERAL: ReadonlySet<string> = new Set(["app.help", "app.settings"]);

export interface PaletteSource {
  readonly terminals: readonly Terminal[];
  /** The core the page goes through: the machine its bare addresses are on, for where an agent runs. */
  readonly host: string;
  /** Every machine, in the person's order: the Hosts group lists them all as peers (#2534 review). */
  readonly machines: readonly string[];
  readonly keymap: Keymap;
  readonly platform: Platform;
  /** The app actions this shell handles now, from availableActions. */
  readonly actions: readonly ShellAction[];
  /** The name the sidebar lists a terminal's space under, by address; the palette names the same space. */
  readonly spaceOf?: (address: string) => string | undefined;
}

export type PaletteChoice =
  | { readonly kind: "agent"; readonly address: string }
  | { readonly kind: "action"; readonly id: string }
  | { readonly kind: "settings" };

function command(source: PaletteSource, { id, unavailable }: ShellAction, group: string): Command {
  const label = ACTION_BY_ID.get(id)?.label ?? id;
  const [trigger] = triggersFor(source.keymap, id);
  const row: Command = { id, label, group };
  if (trigger !== undefined) Object.assign(row, { keys: triggerKeys(trigger, source.platform) });
  return unavailable === undefined ? row : Object.assign(row, { disabled: true, hint: unavailable });
}

/** Agents (live terminals with their state), then Actions, Hosts and General, as DESIGN.md brief (c) lists them. */
export function paletteCommands(source: PaletteSource): Command[] {
  const agents = source.terminals
    .filter((terminal) => terminal.state === "live")
    .toSorted((a, b) => URGENCY[agentStatus(a)] - URGENCY[agentStatus(b)])
    .map((terminal): Command => {
      const machine = machineOf(terminal.address);
      const id = `${AGENT}${terminal.address}`;
      const row: Command = {
        id,
        label: terminalTitle(terminal),
        group: "Agents",
        status: agentStatus(terminal),
        where: agentWhere(terminal, source.host, source.spaceOf?.(terminal.address)),
      };
      return machine === undefined ? row : Object.assign(row, { hint: machine });
    });
  return [
    ...agents,
    ...source.actions.filter((action) => !GENERAL.has(action.id)).map((action) => command(source, action, "Actions")),
    ...source.machines.map((name): Command => ({ id: `${HOST}${name}`, label: name, group: "Hosts" })),
    ...source.actions.filter((action) => GENERAL.has(action.id)).map((action) => command(source, action, "General")),
  ];
}

/** The palette's `spaceOf`: the first listed space showing an address, as the sidebar resolves it (#1486). */
export function spaceNameOf(spaces: readonly ListedSpace[]): (address: string) => string | undefined {
  return (address) => spaceOfAddress(spaces, address)?.name;
}

/** What running a palette row does. */
export function choiceOf(id: string): PaletteChoice {
  if (id.startsWith(AGENT)) return { kind: "agent", address: id.slice(AGENT.length) };
  if (id.startsWith(HOST)) return { kind: "settings" };
  return { kind: "action", id };
}
