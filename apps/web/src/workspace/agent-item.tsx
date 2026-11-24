import {
  AgentFold,
  AgentRow,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  RowWithActions,
  type Agent,
  type AgentStatus,
} from "@doriface/ui";
import { Ellipsis, Pencil, Pin, PinOff, Power } from "lucide-react";
import { memo } from "react";
import { useAskSession } from "./session-context.ts";
import { usePin } from "./use-pin.ts";

/** What can be done with an agent: its "..." menu and its right-click menu hold the same items. */
export function AgentMenuItems({ agent }: { readonly agent: Agent }) {
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
export function AgentActions({ agent }: { readonly agent: Agent }) {
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

export interface AgentItemProps {
  readonly agent: Agent;
  readonly selected: boolean;
  readonly compactBlocked: boolean;
  readonly onOpen: (address: string) => void;
  readonly rail: boolean;
  /** A double-click asks for a new name, as a space row's does (#2658); not on the phone, where a tap opens the agent. */
  readonly doubleClickRenames: boolean;
  readonly depthCap: number;
  readonly disclosure: boolean;
  readonly parentName?: string;
  readonly folded: boolean;
  readonly foldCount: number;
  readonly foldBlocked: number;
  readonly foldUrgency: AgentStatus;
  readonly foldLead: number;
  readonly onToggleFold: (address: string) => void;
}

/** One agent's row with its actions; it draws again only when what it shows changed (#2086). */
export const AgentItem = memo(function AgentItem({
  agent,
  selected,
  compactBlocked,
  onOpen,
  rail,
  doubleClickRenames,
  depthCap,
  disclosure,
  parentName,
  folded,
  foldCount,
  foldBlocked,
  foldUrgency,
  foldLead,
  onToggleFold,
}: AgentItemProps) {
  const ask = useAskSession();
  const row = (
    <AgentRow
      agent={agent}
      selected={selected}
      compactBlocked={compactBlocked}
      onSelect={onOpen}
      rail={rail}
      depthCap={depthCap}
      disclosure={disclosure}
      {...(parentName === undefined ? {} : { parentName })}
      {...(doubleClickRenames ? { onDoubleClick: () => ask({ kind: "rename", address: agent.id }) } : {})}
    />
  );
  // The rail has no room for the hover actions or tree controls, but its right-click opens the same menu (#699).
  if (rail) return <RowWithActions row={row} actions={null} menu={<AgentMenuItems agent={agent} />} />;
  const leading =
    foldCount > 0 ? (
      <AgentFold
        name={agent.name}
        folded={folded}
        count={foldCount}
        blocked={foldBlocked}
        urgency={foldUrgency}
        onToggle={() => onToggleFold(agent.id)}
        style={{ marginLeft: foldLead }}
      />
    ) : undefined;
  return (
    <RowWithActions
      row={row}
      {...(leading === undefined ? {} : { leading })}
      actions={<AgentActions agent={agent} />}
      menu={<AgentMenuItems agent={agent} />}
      coarseActions
    />
  );
});
