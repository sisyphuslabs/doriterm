import type { Terminal } from "@doriface/protocol";
import type { Agent, AgentStatus, Space } from "@doriface/ui";
import { TITLE_LABEL } from "./session-actions.ts";

const OSC_STATES: Readonly<Record<string, AgentStatus>> = {
  working: "working",
  blocked: "blocked",
  error: "blocked",
  done: "done",
  idle: "idle",
};

/**
 * A terminal as the workspace shows it: hc's terminal, plus `offline` when its machine cannot be reached now. hc keeps
 * the last picture it had of such a terminal as live, so the client marks it (`withReach`); hc's own state is untouched.
 */
export type Session = Terminal & { readonly offline?: true };

/**
 * The one status selector every surface uses (sidebar section, pane chip, tab glyph, space attention).
 * A program that never reported OSC 7501, or reported a word outside the protocol's, reads as idle; one on a machine
 * that cannot be reached reads as unknown.
 */
export function agentStatus(terminal: Session): AgentStatus {
  if (terminal.state === "finished") return "done";
  if (terminal.offline === true) return "unknown";
  const word = terminal.status?.state;
  return word !== undefined && Object.hasOwn(OSC_STATES, word) ? (OSC_STATES[word] ?? "idle") : "idle";
}

export function terminalTitle(terminal: Terminal): string {
  const renamed = terminal.labels[TITLE_LABEL];
  if (renamed !== undefined && renamed !== "") return renamed;
  const named = terminal.name ?? terminal.title;
  if (named !== undefined && named !== null && named !== "") return named;
  return terminal.foreground?.name ?? terminal.argv[0] ?? terminal.address;
}

export function machineOf(address: string): string | undefined {
  const slash = address.indexOf("/");
  return slash === -1 ? undefined : address.slice(0, slash);
}

/** A machine's id: `local` for this one, `machine:<name>` for an added one, unique even when the names match. */
export const idOfMachine = (name: string | undefined): string => (name === undefined ? "local" : `machine:${name}`);

/** The id of the machine an address is on: this one for a bare `t7`, the named machine for `machine/t7`. */
export const machineId = (address: string): string => idOfMachine(machineOf(address));

function basename(path: string): string {
  return path.split("/").findLast((part) => part !== "") ?? "/";
}

/** A space is the `space` label, else the working directory's last segment. */
export function spaceName(terminal: Terminal): string {
  return terminal.labels["space"] ?? basename(terminal.foreground?.cwd ?? terminal.cwd);
}

/**
 * Which space a terminal is in: its machine's id and the space name, so a name used on two machines is two spaces.
 * Selection, list keys and opening a space all compare this id, never the name alone.
 */
export function spaceId(terminal: Terminal): string {
  return `${machineId(terminal.address)}/${spaceName(terminal)}`;
}

/** "<1m", "6m", "2h", "3d" since a moment, for agent rows. */
export function formatAge(sinceMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - sinceMs) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Every live terminal as a row: its reported state, what it said, where it runs and since when. */
export function toAgent(terminal: Terminal, nowMs: number): Agent {
  const machine = machineOf(terminal.address);
  const said = terminal.status?.msg ?? terminal.status?.title;
  const detail = said === undefined || said === "" ? spaceName(terminal) : said;
  const agent: Agent = {
    id: terminal.address,
    name: terminalTitle(terminal),
    status: agentStatus(terminal),
    detail,
    age: formatAge(terminal.status_ms ?? terminal.created_ms, nowMs),
  };
  return machine === undefined ? agent : Object.assign(agent, { machine });
}

export interface AgentGroups {
  readonly blocked: readonly Agent[];
  readonly done: readonly Agent[];
  readonly working: readonly Agent[];
  readonly idle: readonly Agent[];
  /** On a machine that cannot be reached: their state is unknown until it is back. */
  readonly offline: readonly Agent[];
}

/** Needs you, Done, Working, Idle, then Offline; programs that never reported sit with Idle. */
export function groupAgents(terminals: readonly Session[], nowMs: number): AgentGroups {
  const groups = { blocked: [] as Agent[], done: [] as Agent[], working: [] as Agent[], idle: [] as Agent[] };
  const offline: Agent[] = [];
  for (const terminal of terminals) {
    if (terminal.state !== "live") continue;
    if (terminal.offline === true) {
      offline.push(toAgent(terminal, nowMs));
      continue;
    }
    const agent = toAgent(terminal, nowMs);
    if (agent.status !== "unknown") groups[agent.status].push(agent);
  }
  return { ...groups, offline };
}

const ATTENTION: readonly AgentStatus[] = ["blocked", "working", "done"];

const remoteRank = (machine: string | undefined): number => (machine === undefined ? 0 : 1);

/** Names in the order a person reads them: numbers by value, so box9 comes before box10. */
export const byName = new Intl.Collator(undefined, { numeric: true });

/** One space per machine and name: this machine's first, then each machine's in name order. */
export function toSpaces(terminals: readonly Terminal[]): Space[] {
  const groups = new Map<string, { name: string; machine: string | undefined; statuses: Set<AgentStatus> }>();
  for (const terminal of terminals) {
    if (terminal.state !== "live") continue;
    const machine = machineOf(terminal.address);
    const key = spaceId(terminal);
    const group = groups.get(key) ?? { name: spaceName(terminal), machine, statuses: new Set<AgentStatus>() };
    group.statuses.add(agentStatus(terminal));
    groups.set(key, group);
  }
  const ordered = [...groups].toSorted(
    ([, a], [, b]) => remoteRank(a.machine) - remoteRank(b.machine) || byName.compare(a.machine ?? "", b.machine ?? ""),
  );
  return ordered.map(([id, group]) => {
    const attention = ATTENTION.find((status) => group.statuses.has(status));
    const tabs = terminals.filter((t) => t.state === "live" && spaceId(t) === id).length;
    const space: Space = { id, name: group.name, tabs };
    if (group.machine !== undefined) Object.assign(space, { machine: group.machine });
    if (attention !== undefined) Object.assign(space, { attention });
    return space;
  });
}

/** The first live terminal of a space, to open when the space is picked. */
export function firstInSpace(terminals: readonly Terminal[], id: string): string | undefined {
  return terminals.find((t) => t.state === "live" && spaceId(t) === id)?.address;
}
