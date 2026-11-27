import type { Terminal } from "@doriface/protocol";
import { agentRowLead, IconButton, Menu, MenuRadioGroup, MenuRadioItem, SidebarSection } from "@doriface/ui";
import { ArrowUpDown, Clock, Layers } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AgentItem } from "./agent-item.tsx";
import { publishAgentOrder } from "./agent-order.ts";
import { ancestorsOf, hiddenUnder } from "./agent-tree.ts";
import { filterAgentGroups } from "./sidebar-filter.ts";
import { agentGroups, type AgentSort, foldAgentGroups } from "./sidebar-model.ts";
import { useAgentSort, useFolded } from "./sidebar-prefs.ts";
import { useSteadyAgents } from "./steady-agents.ts";
import { useTodoOf } from "./todo-progress.ts";
import { useAgentPlaces } from "./use-agent-places.ts";
import { useMachinesContext } from "./use-machines.ts";
import { useNow } from "./use-now.ts";
import { useShown } from "./use-shown.ts";

export interface AgentsGroupProps {
  readonly terminals: readonly Terminal[];
  readonly active: string | null;
  readonly onOpen: (address: string) => void;
  readonly rail?: boolean;
  /** False where the screen's own title already says "Agents" (the phone): the group is labelled, not headed. */
  readonly heading?: boolean;
  /** The sidebar filter's query; the selected agent stays listed whatever it is. */
  readonly query?: string;
}

function SortMenu({ size }: { readonly size?: "md" }) {
  const [sort, setSort] = useAgentSort();
  const triggerIcon = sort === "space" ? <Layers /> : <ArrowUpDown />;
  const trigger =
    size === undefined ? (
      <IconButton label="Sort agents" icon={triggerIcon} className="-mr-1" />
    ) : (
      <IconButton label="Sort agents" icon={triggerIcon} size={size} />
    );
  return (
    <Menu align="end" trigger={trigger}>
      <MenuRadioGroup
        label="Sort agents"
        value={sort}
        onValueChange={(next) => setSort(next === "space" ? "space" : "status")}
      >
        <MenuRadioItem value={"status" satisfies AgentSort} icon={<Clock />}>
          By status
        </MenuRadioItem>
        <MenuRadioItem value={"space" satisfies AgentSort} icon={<Layers />}>
          By space
        </MenuRadioItem>
      </MenuRadioGroup>
    </Menu>
  );
}

/**
 * The phone's sort control, in the Agents screen's header beside its other actions rather than on a row of its own
 * above the list; like the sidebar's, it is there only while there are agents to sort.
 */
export function PhoneSortMenu({ terminals }: { readonly terminals: readonly Terminal[] }) {
  const now = useNow();
  const [sort] = useAgentSort();
  const any = useMemo(() => agentGroups(terminals, now, sort).length > 0, [terminals, now, sort]);
  return any ? <SortMenu size="md" /> : null;
}

/**
 * The agents, first in the sidebar: Pinned, then Needs you, Working, Idle, Done and Offline with counts (or one group
 * per space), each its own list. On the rail the rows are glyphs and the group titles are left to their labels.
 */
export function AgentsGroup({
  terminals: listed,
  active,
  onOpen,
  rail = false,
  heading = true,
  query = "",
}: AgentsGroupProps) {
  const terminals = useShown(listed);
  const now = useNow();
  const [sort] = useAgentSort();
  const todoOf = useTodoOf();
  // A row's place follows its state, never its title, so it is read from the list as shaped.
  const places = useAgentPlaces(listed);
  // One element for the life of the list: a renamed row leaves the sort menu as drawn (#2607).
  const sortMenu = useMemo(() => <SortMenu />, []);
  const opener = useRef(onOpen);
  opener.current = onOpen;
  const open = useCallback((address: string) => opener.current(address), []);
  const built = useMemo(
    () =>
      agentGroups(terminals, now, sort, places).map((group) =>
        Object.assign({}, group, {
          agents: group.agents.map((agent) => {
            const todo = todoOf(agent.id);
            return todo === undefined ? agent : Object.assign({}, agent, { todo });
          }),
        }),
      ),
    [terminals, now, sort, places, todoOf],
  );
  const all = useSteadyAgents(built);
  const { terminalsLoaded, machinesListed, entries } = useMachinesContext();
  const addedMachines = useMemo(
    () => (machinesListed ? new Set(entries.filter((entry) => !entry.local).map((entry) => entry.name)) : null),
    [machinesListed, entries],
  );
  const listedAddresses = useMemo(
    () => new Set(listed.filter((terminal) => terminal.state === "live").map((terminal) => terminal.address)),
    [listed],
  );
  const fedAddresses = useMemo(() => new Set(listed.map((terminal) => terminal.address)), [listed]);
  const [folded, toggleFold] = useFolded(listedAddresses, fedAddresses, terminalsLoaded, addedMachines);
  const foldToggler = useRef(toggleFold);
  foldToggler.current = toggleFold;
  const onToggleFold = useCallback((address: string) => foldToggler.current(address), []);
  // A query shows a matching sub-agent with the agents above it, so nothing is folded away while one is typed.
  const narrowed = useMemo(() => filterAgentGroups(all, query, active), [all, query, active]);
  const queryBlank = narrowed === all;
  const foldedSet = useMemo(() => new Set(folded), [folded]);
  const groups = useMemo(
    () => (rail || !queryBlank ? narrowed : foldAgentGroups(narrowed, folded, active)),
    [rail, queryBlank, narrowed, folded, active],
  );
  useEffect(() => publishAgentOrder(groups.flatMap((group) => group.agents.map((agent) => agent.id))), [groups]);
  const tree = !rail && narrowed.some((group) => group.agents.some((agent) => (agent.descendants ?? 0) > 0));
  const depthCap = heading ? 3 : 2;
  const list = (
    <div className="flex flex-col gap-4 pt-1">
      {groups.map((group, groupIndex) => {
        const unfoldedAgents = narrowed[groupIndex]?.agents ?? group.agents;
        const unfoldedIndexById = new Map(unfoldedAgents.map((agent, idx) => [agent.id, idx]));
        const nameById = new Map(group.agents.map((agent) => [agent.id, agent.name]));
        const activeIndex = active === null ? -1 : group.agents.findIndex((agent) => agent.id === active);
        const activeAncestors = new Set(activeIndex === -1 ? [] : ancestorsOf(group.agents, activeIndex));
        return (
          <SidebarSection
            key={group.key}
            title={group.title}
            count={group.count}
            {...(group.tone === undefined ? {} : { tone: group.tone })}
            {...(rail ? { className: "[&>header]:sr-only" } : {})}
          >
            {group.agents.map((agent, index) => {
              const hasFold = !rail && queryBlank && (agent.descendants ?? 0) > 0;
              const unfoldedIndex = hasFold ? (unfoldedIndexById.get(agent.id) ?? -1) : -1;
              const hidden = unfoldedIndex === -1 ? undefined : hiddenUnder(unfoldedAgents, unfoldedIndex);
              const isFolded =
                hasFold && foldedSet.has(agent.id) && (group.agents[index + 1]?.depth ?? 0) <= (agent.depth ?? 0);
              const foldDisabled = hasFold && activeAncestors.has(agent.id);
              const parentId = ancestorsOf(group.agents, index)[0];
              const parentName = parentId === undefined ? undefined : nameById.get(parentId);
              const foldLead = hasFold ? agentRowLead(agent.depth ?? 0, depthCap) : 0;
              return (
                <AgentItem
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === active}
                  compactBlocked={group.compactBlocked}
                  onOpen={open}
                  rail={rail}
                  doubleClickRenames={heading}
                  depthCap={depthCap}
                  disclosure={tree}
                  {...(parentName === undefined ? {} : { parentName })}
                  folded={isFolded}
                  foldDisabled={foldDisabled}
                  foldCount={hidden?.count ?? 0}
                  foldBlocked={hidden?.blocked ?? 0}
                  foldUrgency={hidden?.urgency ?? "idle"}
                  foldLead={foldLead}
                  onToggleFold={onToggleFold}
                />
              );
            })}
          </SidebarSection>
        );
      })}
    </div>
  );
  const totalAgents = useMemo(() => groups.reduce((sum, group) => sum + group.count, 0), [groups]);
  if (!heading)
    return (
      <section aria-label="Agents" className="flex flex-col gap-px">
        {list}
      </section>
    );
  return (
    <SidebarSection
      variant="region"
      title="Agents"
      {...(totalAgents > 0 ? { count: totalAgents } : {})}
      {...(rail ? { className: "[&>header]:sr-only" } : totalAgents > 0 ? { action: sortMenu } : {})}
    >
      {groups.length === 0 ? (
        rail ? null : (
          <p className="px-2 py-1 text-xs text-muted-foreground/70">No active agents</p>
        )
      ) : (
        list
      )}
    </SidebarSection>
  );
}
