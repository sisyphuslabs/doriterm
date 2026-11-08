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
  /** The sidebar filter's query: only rows whose labels match it are listed. */
  readonly query?: string;
}

/** The desktop sidebar's lists as herdr-app lays them out: Spaces on top, Agents docked at the bottom, a divider between. */
export function SidebarLists({ terminals, active, onOpen, rail = false, query = "" }: AgentListsProps) {
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
