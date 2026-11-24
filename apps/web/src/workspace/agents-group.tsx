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
import { agentGroups, type AgentSort, foldAgentGroups } from "./sidebar-model.ts";
import { useAgentSort, useFolded } from "./sidebar-prefs.ts";
import { useSteadyAgents } from "./steady-agents.ts";
import { useMachinesContext } from "./use-machines.ts";
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
  /** A double-click asks for a new name, as a space row's does (#2658); not on the phone, where a tap opens the agent. */
  readonly doubleClickRenames: boolean;
}

/** One agent's row with its actions; it draws again only when that agent, its selection or the rail changed (#2086). */
const AgentItem = memo(function AgentItem({
  agent,
  selected,
  compactBlocked,
  onOpen,
  rail,
  doubleClickRenames,
}: AgentItemProps) {
  const ask = useAskSession();
  const row = (
    <AgentRow
      agent={agent}
      selected={selected}
      compactBlocked={compactBlocked}
      onSelect={onOpen}
      rail={rail}
      {...(doubleClickRenames ? { onDoubleClick: () => ask({ kind: "rename", address: agent.id }) } : {})}
    />
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
  const { terminalsLoaded } = useMachinesContext();
  const listedAddresses = useMemo(
    () => new Set(listed.filter((terminal) => terminal.state === "live").map((terminal) => terminal.address)),
    [listed],
  );
  const [folded] = useFolded(listedAddresses, terminalsLoaded);
  // A query shows a matching sub-agent with the agents above it, so nothing is folded away while one is typed.
  const groups = useMemo(() => {
    const narrowed = filterAgentGroups(all, query, active);
    return narrowed === all ? foldAgentGroups(all, folded, active) : narrowed;
  }, [all, query, active, folded]);
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
              doubleClickRenames={heading}
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
