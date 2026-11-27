import type { Agent, AgentStatus, AvatarColor, Space } from "@doriface/ui";
import { AVATAR_COLORS } from "@doriface/ui";
import type { AgentPlaces } from "./agent-places.ts";
import { agentTree, foldRows, STATUS_RANK, withShape } from "./agent-tree.ts";
import { agentStatus } from "./attention.ts";
import type { MachineEntry } from "./machines.ts";
import { type Session, toAgent } from "./model.ts";

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
   * The header's count: every terminal the group lists, by its place, so a row held in Working through its wait counts
   * there (#1963). A sub-agent is counted with the agent that started it, in that agent's group, and nowhere else, so
   * the counts together are the live terminals, each once (#2122); folding a row away does not change its group's count
   * (#2746). Pinned agents are counted in Pinned, where they are listed. The palette's status filter counts live states
   * instead, as the rows it filters by are.
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

/** A top-level row with the sub-agents drawn under it: what a group lists, sorts and counts as one. */
interface Branch {
  readonly head: Session;
  readonly pinned: boolean;
  /** The section the head's row is listed in: Offline for an unreachable machine, else its bubbled urgency. */
  readonly section: AgentStatus | "offline";
  readonly base: number;
  readonly rows: Agent[];
}

/**
 * The tree cut into what each group lists: one branch per top-level row, and one per pinned row under an unpinned
 * one, which is listed in Pinned with its own sub-agents and not a second time under its parent.
 */
function branches(terminals: readonly Session[], nowMs: number, places: AgentPlaces): Branch[] {
  const byAddress = new Map(terminals.map((terminal) => [terminal.address, terminal]));
  const placed = (terminal: Session): AgentStatus =>
    terminal.offline === true ? "unknown" : (places.get(terminal.address)?.status ?? agentStatus(terminal));
  const found: Branch[] = [];
  const above: { readonly depth: number; readonly branch: Branch }[] = [];
  for (const row of agentTree(terminals, placed, isPinned)) {
    const terminal = byAddress.get(row.address);
    if (terminal === undefined) continue;
    while ((above.at(-1)?.depth ?? -1) >= row.depth) above.pop();
    const under = above.at(-1)?.branch;
    const pinned = isPinned(terminal);
    let branch = under;
    if (branch === undefined || (pinned && !branch.pinned)) {
      const section = terminal.offline === true ? ("offline" as const) : row.urgency;
      branch = { head: terminal, pinned, section, base: row.depth, rows: [] };
      found.push(branch);
    }
    above.push({ depth: row.depth, branch });
    const agent = Object.assign(toAgent(terminal, nowMs), { depth: row.depth - branch.base, urgency: row.urgency });
    branch.rows.push(pinned ? Object.assign(agent, { pinned: true }) : agent);
  }
  return found;
}

const rankOf = (branch: Branch): number => (branch.section === "offline" ? 4 : STATUS_RANK[branch.section]);

/**
 * The agents list, pinned agents first in their own group, then by status (Needs you, Working, Idle, Done, Offline)
 * or by space (each space's agents most urgent first). Empty groups are left out. A row is listed by its `places` entry
 * where it has one (`placeAgents`), so a turn between Working and Idle moves it only once it has held (#1949).
 *
 * A sub-agent is listed right under the agent that started it (`agentTree`), depth first, whatever its own state or
 * space, and that top-level row is placed by the most urgent of itself and its live sub-agents (#2746).
 */
export function agentGroups(
  terminals: readonly Session[],
  nowMs: number,
  sort: AgentSort,
  places: AgentPlaces = new Map(),
): AgentGroup[] {
  const order = new Map(terminals.map((terminal, index) => [terminal.address, index]));
  const all = branches(terminals, nowMs, places).toSorted(
    (a, b) => rankOf(a) - rankOf(b) || (order.get(a.head.address) ?? 0) - (order.get(b.head.address) ?? 0),
  );
  const listed = (own: readonly Branch[]): { readonly agents: readonly Agent[]; readonly count: number } => {
    const agents = own.flatMap((branch) => withShape(branch.rows));
    return { agents, count: agents.length };
  };
  const pinned = all.filter((branch) => branch.pinned);
  const rest = all.filter((branch) => !branch.pinned);
  const head: AgentGroup[] =
    pinned.length === 0 ? [] : [{ key: "pinned", title: "Pinned", compactBlocked: false, ...listed(pinned) }];
  if (sort === "status") {
    return [
      ...head,
      ...STATUS_GROUPS.flatMap((group) => {
        const own = rest.filter((branch) => branch.section === group.key);
        return own.length === 0 ? [] : [{ ...group, compactBlocked: group.key === "blocked", ...listed(own) }];
      }),
    ];
  }
  const bySpace = new Map<string, Branch[]>();
  for (const branch of rest) {
    const top = branch.rows[0];
    const space = branch.head.labels["space"] ?? top?.detail ?? "";
    const title = top?.machine === undefined ? space : `${space} · ${top.machine}`;
    bySpace.set(title, [...(bySpace.get(title) ?? []), branch]);
  }
  return [
    ...head,
    ...[...bySpace].map(([title, own]) =>
      Object.assign({ key: `space:${title}`, title, compactBlocked: false }, listed(own)),
    ),
  ];
}

/**
 * The groups with each folded agent's sub-agents left out (`foldRows`): the folded row stays, with the count of what it
 * hides, and every group keeps its count. Gives back `groups` itself when nothing is folded away.
 */
export function foldAgentGroups(
  groups: readonly AgentGroup[],
  folded: readonly string[],
  selected: string | null,
): readonly AgentGroup[] {
  if (folded.length === 0) return groups;
  const closed = new Set(folded);
  let changed = false;
  const next = groups.map((group) => {
    const agents = foldRows(group.agents, closed, selected);
    if (agents === group.agents) return group;
    changed = true;
    return { ...group, agents };
  });
  return changed ? next : groups;
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
 * Spaces under their machine, in the machines' own order (this one first, then as the person ordered them), once more
 * than one machine is known; with one machine there is nothing to group and this returns undefined. A machine counts
 * its spaces' tabs, never its terminals: a terminal in no tab yet and a split tab's other panes are in no row
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
