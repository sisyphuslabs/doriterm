import type { AgentStatus, WorkspaceTab } from "@doriface/ui";
import { agentStatus } from "./attention.ts";
import type { LayoutTab } from "./layout-model.ts";
import { programKind, type Session, tabTitle } from "./model.ts";
import { panelId } from "./split-panes.tsx";
import { frontIcon } from "./tab-live.tsx";

/** A tab's glyph: the state that most needs the person among its panes, as the sidebar sections rank them. */
const URGENCY: readonly AgentStatus[] = ["blocked", "done", "working", "idle", "unknown"];

/**
 * A tab as the strip draws it: its name, else its agent's title (#1541), else its place in its space (1, 2, ...), with the icon of its agent,
 * else of its first pane's program, and the state that most needs the person among its panes. No machine label: the bar
 * shows one space's tabs, and a space is one machine's (#404, #478).
 */
export function tabEntry(
  tab: LayoutTab,
  position: number,
  byAddress: ReadonlyMap<string, Session>,
  /** The terminal whose close waits for its tab to be placed (useTabClosing): its tab shows the close as taken. */
  closeWaiting: string | null = null,
): WorkspaceTab {
  const shown = tab.panes.flatMap((pane) => {
    const terminal = pane.address === null ? undefined : byAddress.get(pane.address);
    return terminal === undefined ? [] : [terminal];
  });
  const agent = shown.find((terminal) => programKind(terminal) === "agent");
  const first = shown[0];
  const lead = agent ?? first;
  const icon = lead === undefined ? undefined : frontIcon(lead);
  const statuses = new Set(shown.map(agentStatus));
  const status = URGENCY.find((each) => statuses.has(each));
  return {
    id: tab.key,
    arrivalKey: tab.mount ?? tab.key,
    title: tabTitle(tab.name, position, agent, first),
    controls: panelId(tab.key),
    pinned: tab.pinned,
    ...(icon === undefined ? {} : { icon }),
    ...(status === undefined ? {} : { status }),
    ...(closeWaiting !== null && tab.panes.some((pane) => pane.address === closeWaiting) ? { closing: true } : {}),
  };
}
