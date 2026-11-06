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
import { useMemo } from "react";
import { useAskSession } from "./session-context.ts";
import { filterAgentGroups } from "./sidebar-filter.ts";
import { agentGroups, type AgentSort } from "./sidebar-model.ts";
import { useAgentSort } from "./sidebar-prefs.ts";
import { usePin } from "./use-pin.ts";
import { useNow } from "./use-now.ts";
import { useTodoOf } from "./todo-progress.ts";

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
        label={`${pinned ? "Unpin" : "Pin"} ${agent.name}`}
        icon={pinned ? <PinOff /> : <Pin />}
        className="size-6 coarse:hidden"
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

/**
 * The agents, first in the sidebar: Pinned, then Needs you, Working, Idle, Done and Offline with counts (or one group
 * per space), each its own list. On the rail the rows are glyphs and the group titles are left to their labels.
 */
export function AgentsGroup({ terminals, active, onOpen, rail = false, heading = true, query = "" }: AgentsGroupProps) {
  const now = useNow();
  const [sort] = useAgentSort();
  const todoOf = useTodoOf();
  const all = useMemo(
    () =>
      agentGroups(terminals, now, sort).map((group) =>
        Object.assign({}, group, {
          agents: group.agents.map((agent) => {
            const todo = todoOf(agent.id);
            return todo === undefined ? agent : Object.assign({}, agent, { todo });
          }),
        }),
      ),
    [terminals, now, sort, todoOf],
  );
  const groups = useMemo(() => filterAgentGroups(all, query, active), [all, query, active]);
  const list = (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <SidebarSection
          key={group.key}
          title={group.title}
          count={group.count}
          {...(group.tone === undefined ? {} : { tone: group.tone })}
          {...(rail ? { className: "[&>header]:sr-only" } : {})}
        >
          {group.agents.map((agent) => {
            const row = (
              <AgentRow
                agent={agent}
                selected={agent.id === active}
                compactBlocked={group.compactBlocked}
                onSelect={onOpen}
                rail={rail}
              />
            );
            return rail ? (
              <div key={agent.id}>{row}</div>
            ) : (
              <RowWithActions
                key={agent.id}
                row={row}
                actions={<AgentActions agent={agent} />}
                menu={<AgentMenuItems agent={agent} />}
                coarseActions
              />
            );
          })}
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
    <SidebarSection title="Agents" {...(rail ? { className: "[&>header]:sr-only" } : { action: <SortMenu /> })}>
      {list}
    </SidebarSection>
  );
}
