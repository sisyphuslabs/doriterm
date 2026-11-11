import type { Agent, Space } from "@doriface/ui";
import { type AgentGroup, type MachineGroup, tabsIn } from "./sidebar-model.ts";

/** The query's words, lower-cased; none for a blank query. */
const words = (query: string): readonly string[] => query.trim().toLowerCase().split(/\s+/u).filter(Boolean);

/** The word's letters appear in the label in order, with anything between them. */
function subsequence(word: string, label: string): boolean {
  let at = 0;
  for (const letter of label) {
    if (letter === word[at]) at += 1;
    if (at === word.length) return true;
  }
  return false;
}

/**
 * A fuzzy match over the labels a row shows: every word of the query has its letters, in order, in one of them, case
 * ignored. A blank query matches everything.
 */
export function matchesQuery(query: string, labels: readonly string[]): boolean {
  const lower = labels.map((label) => label.toLowerCase());
  return words(query).every((word) => lower.some((label) => subsequence(word, label)));
}

/** What an agent row shows: its name, its detail and, for an agent on another machine, that machine. */
const agentLabels = (agent: Agent): string[] => [agent.name, agent.detail ?? "", agent.machine ?? ""];

/** What a space row shows: its name, its git branch when it shows one and, unless its header says it, its machine. */
const spaceLabels = (space: Space, hideMachine: boolean): string[] => [
  space.name,
  space.git?.branch ?? "",
  ...(hideMachine ? [] : [space.machine ?? ""]),
];

/**
 * The agent groups narrowed to the rows matching the query: membership only (the rows are the same objects in the same
 * order), the selected row kept as context, empty groups left out and counts following. A blank query gives back the
 * same array, so clearing the field restores the lists exactly.
 */
export function filterAgentGroups(
  groups: readonly AgentGroup[],
  query: string,
  selected: string | null,
): readonly AgentGroup[] {
  if (words(query).length === 0) return groups;
  return groups.flatMap((group) => {
    const agents = group.agents.filter((agent) => agent.id === selected || matchesQuery(query, agentLabels(agent)));
    return agents.length === 0 ? [] : [{ ...group, agents, count: agents.length }];
  });
}

/** The spaces matching the query by the labels their rows show, the selected one kept. A blank query gives back the same array. */
export function filterSpaces(
  spaces: readonly Space[],
  query: string,
  selected: string | null,
  { hideMachine = false }: { readonly hideMachine?: boolean } = {},
): readonly Space[] {
  if (words(query).length === 0) return spaces;
  return spaces.filter((space) => space.id === selected || matchesQuery(query, spaceLabels(space, hideMachine)));
}

/**
 * The machine groups under a query: a machine whose name matches keeps all its spaces; any other keeps its matching
 * spaces (its rows hide the machine, so only their names are searched), its count following them, and is left out when
 * none match. A blank query gives back the same array.
 */
export function filterMachineGroups(
  groups: readonly MachineGroup[],
  query: string,
  selected: string | null,
): readonly MachineGroup[] {
  if (words(query).length === 0) return groups;
  return groups.flatMap((group) => {
    if (matchesQuery(query, [group.machine.name])) return [group];
    const spaces = filterSpaces(group.spaces, query, selected, { hideMachine: true });
    return spaces.length === 0 ? [] : [{ ...group, spaces, tabs: tabsIn(spaces) }];
  });
}
