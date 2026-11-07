import type { Terminal } from "@doriface/protocol";
import { AgentsGroup } from "./agents-group.tsx";
import { SidebarSplit } from "./sidebar-split.tsx";
import { useMachinesContext } from "./use-machines.ts";
import { SpacesGroup } from "./spaces-group.tsx";
import { TerminalsLoadError } from "./terminals-load-error.tsx";

export interface AgentListsProps {
  readonly terminals: readonly Terminal[];
  readonly active: string | null;
  readonly onOpen: (address: string) => void;
  /** The desktop sidebar dragged narrow: glyphs and avatars only. */
  readonly rail?: boolean;
  /** False on the phone, whose screen title already says "Agents". */
  readonly heading?: boolean;
  /** The sidebar filter's query: only rows whose labels match it are listed. */
  readonly query?: string;
}

/** The phone's one list: the agents its screen is titled for, then the spaces (under their machines once there are more). */
export function AgentLists({ terminals, active, onOpen, rail = false, heading = true }: AgentListsProps) {
  // Nothing until the terminal list is in: the agents then draw in their final place, and the spaces (or their loading
  // row) below them, so nothing already drawn moves.
  const { terminalsLoaded, terminalsError, retryTerminals } = useMachinesContext();
  if (!terminalsLoaded && terminalsError !== null)
    return <TerminalsLoadError cause={terminalsError} onRetry={retryTerminals} />;
  if (!terminalsLoaded) return <div aria-busy="true" className="px-2 pb-3" />;
  return (
    <div className="flex flex-col gap-4 px-2 pb-3">
      <AgentsGroup terminals={terminals} active={active} onOpen={onOpen} rail={rail} heading={heading} />
      <SpacesGroup onOpen={onOpen} rail={rail} />
    </div>
  );
}

/** The desktop sidebar's lists as herdr-app lays them out: Spaces on top, Agents docked at the bottom, a divider between. */
export function SidebarLists({
  terminals,
  active,
  onOpen,
  rail = false,
  query = "",
}: Omit<AgentListsProps, "heading">) {
  const { terminalsLoaded, terminalsError, retryTerminals } = useMachinesContext();
  const pad = "px-2 pb-3";
  // A first answer that failed is said once, in place of the lists, not as a load that never ends (#819).
  const waiting =
    terminalsError === null ? (
      <div aria-busy="true" className={pad} />
    ) : (
      <TerminalsLoadError cause={terminalsError} onRetry={retryTerminals} />
    );
  return (
    <SidebarSplit
      spaces={
        terminalsLoaded ? (
          <div className={pad}>
            <SpacesGroup onOpen={onOpen} rail={rail} query={query} filterable />
          </div>
        ) : (
          waiting
        )
      }
      agents={
        terminalsLoaded ? (
          <div className={pad}>
            <AgentsGroup terminals={terminals} active={active} onOpen={onOpen} rail={rail} query={query} />
          </div>
        ) : (
          <div aria-busy="true" className={pad} />
        )
      }
    />
  );
}
