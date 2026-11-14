import type { Terminal } from "@doriface/protocol";
import {
  AgentRow,
  IconButton,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  RowWithActions,
  SidebarSection,
  type Agent,
} from "@doriface/ui";
import { Clock, Ellipsis, Layers, Pencil, Pin, PinOff, Power } from "lucide-react";
import { memo, useCallback, useMemo, useRef } from "react";
import { useAskSession } from "./session-context.ts";
import { filterAgentGroups } from "./sidebar-filter.ts";
import { type AgentGroup, agentGroups, type AgentSort } from "./sidebar-model.ts";
import { useAgentSort } from "./sidebar-prefs.ts";
import { useAgentPlaces } from "./use-agent-places.ts";
import { usePin } from "./use-pin.ts";
import { useNow } from "./use-now.ts";
import { useTodoOf } from "./todo-progress.ts";
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
  const trigger =
    size === undefined ? (
      <IconButton label="Sort agents" icon={<Clock />} className="-mr-1" />
    ) : (
      <IconButton label="Sort agents" icon={<Clock />} size={size} />
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

/** What can be done with an agent: its "..." menu and its right-click menu hold the same items. */
function AgentMenuItems({ agent }: { readonly agent: Agent }) {
  const pin = usePin();
  const ask = useAskSession();
  const pinned = agent.pinned === true;
  return (
    <>
      <MenuItem icon={pinned ? <PinOff /> : <Pin />} onClick={() => pin(agent.id, !pinned)}>
        {pinned ? "Unpin" : "Pin to top"}
      </MenuItem>
      <MenuItem icon={<Pencil />} onClick={() => ask({ kind: "rename", address: agent.id })}>
        Rename…
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={<Power />} destructive onClick={() => ask({ kind: "end", address: agent.id })}>
        End session…
      </MenuItem>
    </>
  );
}

/**
 * Hover or keyboard focus shows only these two; everything else about the agent is in the "..." menu. A touch screen
 * draws More alone: Pin is its menu's first item, and the row keeps its age and machine (#950, after #798/#808).
 */
function AgentActions({ agent }: { readonly agent: Agent }) {
  const pin = usePin();
  const pinned = agent.pinned === true;
  return (
    <>
      <IconButton
        label={pinned ? `Unpin ${agent.name}` : `Pin ${agent.name} to the top`}
        // One pin shape at the resting pin's 14 px: Unpin draws that same pin filled, since PinOff's slashed body is drawn
        // smaller inside the same box and would shrink under the pointer (#1562). Only Unpin stands in for that pin; an
        // unpinned row's Pin to top keeps the actions' own size, the same as More beside it (#1555).
        icon={pinned ? <Pin className="fill-current" /> : <Pin />}
        className={pinned ? "size-6 coarse:hidden [&_svg:not([data-slot=spinner])]:size-3.5" : "size-6 coarse:hidden"}
        onClick={() => pin(agent.id, !pinned)}
      />
      <Menu
        align="end"
        trigger={<IconButton label={`More for ${agent.name}`} icon={<Ellipsis />} className="size-6" />}
      >
        <AgentMenuItems agent={agent} />
      </Menu>
    </>
  );
}

interface AgentItemProps {
  readonly agent: Agent;
  readonly selected: boolean;
  readonly compactBlocked: boolean;
  readonly onOpen: (address: string) => void;
  readonly rail: boolean;
}

/** One agent's row with its actions; it draws again only when that agent, its selection or the rail changed (#2086). */
const AgentItem = memo(function AgentItem({ agent, selected, compactBlocked, onOpen, rail }: AgentItemProps) {
  const row = (
    <AgentRow agent={agent} selected={selected} compactBlocked={compactBlocked} onSelect={onOpen} rail={rail} />
  );
  // The rail has no room for the hover actions, but its right-click opens the same menu (#699).
  return rail ? (
    <RowWithActions row={row} actions={null} menu={<AgentMenuItems agent={agent} />} />
  ) : (
    <RowWithActions
      row={row}
      actions={<AgentActions agent={agent} />}
      menu={<AgentMenuItems agent={agent} />}
      coarseActions
    />
  );
});

/** Whether a sidebar row would draw the same for both: every field AgentRow shows (#2098). */
export const sameAgent = (a: Agent, b: Agent): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.status === b.status &&
  a.detail === b.detail &&
  a.machine === b.machine &&
  a.age === b.age &&
  a.pinned === b.pinned &&
  a.icon === b.icon &&
  a.todo?.done === b.todo?.done &&
  a.todo?.total === b.todo?.total;

/**
 * Each agent as the render before drew it while nothing it shows changed. The groups are built afresh on every terminal
 * event; without this every row of every agent drew again for one agent's title (#2086).
 */
function useSteadyAgents(groups: readonly AgentGroup[]): readonly AgentGroup[] {
  const drawn = useRef(new Map<string, Agent>());
  return useMemo(() => {
    const before = drawn.current;
    const now = new Map<string, Agent>();
    const steady = groups.map((group) =>
      Object.assign({}, group, {
        agents: group.agents.map((agent) => {
          const kept = before.get(agent.id);
          const shown = kept !== undefined && sameAgent(kept, agent) ? kept : agent;
          now.set(agent.id, shown);
          return shown;
        }),
      }),
    );
    drawn.current = now;
    return steady;
  }, [groups]);
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
  const groups = useMemo(() => filterAgentGroups(all, query, active), [all, query, active]);
  const list = (
    <div className="flex flex-col gap-6 pt-3">
      {groups.map((group) => (
        <SidebarSection
          key={group.key}
          title={group.title}
          count={group.count}
          {...(group.tone === undefined ? {} : { tone: group.tone })}
          {...(rail ? { className: "[&>header]:sr-only" } : {})}
        >
          {group.agents.map((agent) => (
            <AgentItem
              key={agent.id}
              agent={agent}
              selected={agent.id === active}
              compactBlocked={group.compactBlocked}
              onOpen={open}
              rail={rail}
            />
          ))}
        </SidebarSection>
      ))}
    </div>
  );
  if (!heading)
    return (
      <section aria-label="Agents" className="flex flex-col gap-px">
        {list}
      </section>
    );
  return (
    <SidebarSection title="Agents" {...(rail ? { className: "[&>header]:sr-only" } : { action: sortMenu })}>
      {list}
    </SidebarSection>
  );
}
