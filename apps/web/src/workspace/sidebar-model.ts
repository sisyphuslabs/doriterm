import type { Agent, AvatarColor, Space } from "@doriface/ui";
import { AVATAR_COLORS } from "@doriface/ui";
import type { AgentPlaces } from "./agent-places.ts";
import type { MachineEntry } from "./machines.ts";
import { groupAgents, type Session } from "./model.ts";

/** herdr-app's pin label: a pinned terminal carries it, so the pin lives in hc and follows the terminal everywhere. */
export const PIN_LABEL = "herdr.pinned";

export const isPinned = (terminal: Session): boolean => (terminal.labels[PIN_LABEL] ?? "") !== "";

export type AgentSort = "status" | "space";

export interface AgentGroup {
  readonly key: string;
  readonly title: string;
  /** Text colour class for the title: the status inks for the status groups. */
  readonly tone?: string;
  /** Needs you's rows use the "!" mark, since the header already says it. */
  readonly compactBlocked: boolean;
  readonly agents: readonly Agent[];
  /**
   * The header's count: the rows the group shows, by their place, so a row held in Working through its wait counts
   * there (#1963). Pinned agents are counted in Pinned, where they are listed. The palette's status filter counts live
   * states instead, as the rows it filters by are.
   */
  readonly count: number;
}

const STATUS_GROUPS = [
  { key: "blocked", title: "Needs you", tone: "text-status-blocked-text" },
  { key: "working", title: "Working", tone: "text-status-working-text" },
  { key: "idle", title: "Idle" },
  { key: "done", title: "Done", tone: "text-status-done-text" },
  { key: "offline", title: "Offline" },
] as const;

const RANK: Readonly<Record<string, number>> = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 };

/**
 * The agents list, pinned agents first in their own group, then by status (Needs you, Working, Idle, Done, Offline)
 * or by space (each space's agents most urgent first). Empty groups are left out. A row is listed by its `places` entry
 * where it has one (`placeAgents`), so a turn between Working and Idle moves it only once it has held (#1949).
 */
export function agentGroups(
  terminals: readonly Session[],
  nowMs: number,
  sort: AgentSort,
  places: AgentPlaces = new Map(),
): AgentGroup[] {
  const pinnedIds = new Set(terminals.filter(isPinned).map((terminal) => terminal.address));
  const groups = groupAgents(terminals, nowMs);
  const offline = new Set(groups.offline.map((agent) => agent.id));
  const placed = (agent: Agent): string =>
    offline.has(agent.id) ? "offline" : (places.get(agent.id)?.status ?? agent.status);
  const order = new Map(terminals.map((terminal, index) => [terminal.address, index]));
  const all = STATUS_GROUPS.flatMap(({ key }) => groups[key]).toSorted(
    (a, b) => (RANK[placed(a)] ?? 4) - (RANK[placed(b)] ?? 4) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  for (const agent of all) if (pinnedIds.has(agent.id)) Object.assign(agent, { pinned: true });
  const pinned = all.filter((agent) => agent.pinned === true);
  const rest = all.filter((agent) => agent.pinned !== true);
  const head: AgentGroup[] =
    pinned.length === 0
      ? []
      : [{ key: "pinned", title: "Pinned", compactBlocked: false, agents: pinned, count: pinned.length }];
  if (sort === "status") {
    return [
      ...head,
      ...STATUS_GROUPS.flatMap((group) => {
        const agents = rest.filter((agent) => placed(agent) === group.key);
        return agents.length === 0
          ? []
          : [{ ...group, compactBlocked: group.key === "blocked", agents, count: agents.length }];
      }),
    ];
  }
  const bySpace = new Map<string, Agent[]>();
  for (const agent of rest) {
    const terminal = terminals.find((one) => one.address === agent.id);
    const space = terminal?.labels["space"] ?? agent.detail ?? "";
    const title = agent.machine === undefined ? space : `${space} · ${agent.machine}`;
    bySpace.set(title, [...(bySpace.get(title) ?? []), agent]);
  }
  return [
    ...head,
    ...[...bySpace].map(([title, agents]) => ({
      key: `space:${title}`,
      title,
      compactBlocked: false,
      count: agents.length,
      agents: agents.toSorted((a, b) => (RANK[placed(a)] ?? 4) - (RANK[placed(b)] ?? 4)),
    })),
  ];
}

/**
 * Each space keeps the colour it was given; a new one takes the least used colour (the first in AVATAR_COLORS on a
 * tie), and colours of spaces that are gone are dropped. Returns the same object when nothing changed.
 */
export function assignColors(
  saved: Readonly<Record<string, AvatarColor>>,
  ids: readonly string[],
): Readonly<Record<string, AvatarColor>> {
  const present = new Set(ids);
  const kept: Record<string, AvatarColor> = {};
  for (const [id, color] of Object.entries(saved)) if (present.has(id)) kept[id] = color;
  let changed = Object.keys(kept).length !== Object.keys(saved).length;
  for (const id of ids) {
    if (kept[id] !== undefined) continue;
    const uses = (color: AvatarColor): number => Object.values(kept).filter((one) => one === color).length;
    kept[id] = AVATAR_COLORS.reduce((best, color) => (uses(color) < uses(best) ? color : best));
    changed = true;
  }
  return changed ? kept : saved;
}

export interface MachineGroup {
  readonly machine: MachineEntry;
  readonly spaces: readonly Space[];
  /** The header's count: the tabs of the spaces the group lists, so it is the sum of the counts on the rows under it. */
  readonly tabs: number;
}

/** The tabs of these spaces together: what a machine's header counts for the spaces listed under it (#2122). */
export const tabsIn = (spaces: readonly Space[]): number => spaces.reduce((sum, space) => sum + space.tabs, 0);

/**
 * Spaces under their machine, in the machines' own order (as the person ordered them, by name before that), once more
 * than one machine is known; with one machine there is nothing to group and this returns undefined. A machine counts
 * its spaces' tabs, never its terminals: a sub-agent, a terminal in no tab and a split tab's other panes are in no row
 * under it, and an offline machine's rows still count the tabs last read from it.
 */
export function machineGroups(
  machines: readonly MachineEntry[],
  spaces: readonly Space[],
): readonly MachineGroup[] | undefined {
  if (machines.length < 2) return undefined;
  return machines.map((machine) => {
    const own = spaces.filter((space) => (space.machine ?? undefined) === (machine.local ? undefined : machine.name));
    return { machine, spaces: own, tabs: tabsIn(own) };
  });
}

/**
 * The spaces in the order the sidebar shows them, which the space keys count by: with one machine its document's order,
 * else each machine's spaces under that machine, the machines as the person ordered them.
 */
export function spacesInOrder(machines: readonly MachineEntry[], spaces: readonly Space[]): readonly Space[] {
  const groups = machineGroups(machines, spaces);
  return groups === undefined ? spaces : groups.flatMap((group) => group.spaces);
}
