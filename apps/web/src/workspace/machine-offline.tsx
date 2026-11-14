import { EmptyState, cn } from "@doriface/ui";
import { Unplug } from "lucide-react";
import { machineCause } from "./machine-cause.ts";
import { offlineReason } from "./machine-state.ts";
import { RemoveMachineButton, removable } from "./remove-machine.tsx";
import { RetryButton } from "./retry-button.tsx";
import { useMachinesContext } from "./use-machines.ts";

export interface MachineOfflineProps {
  readonly machine: string;
  readonly className?: string;
}

/**
 * Shown instead of a terminal whose machine cannot be reached: why, in plain words, a way to dial it now and, for a
 * machine added by hand, a way to remove it (#2456).
 */
export function MachineOffline({ machine, className }: MachineOfflineProps) {
  const { views, retry, remove } = useMachinesContext();
  const view = views.find((entry) => entry.name === machine);
  const cause = view === undefined ? undefined : machineCause(view);
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col justify-center bg-card", className)}>
      <EmptyState
        icon={<Unplug aria-hidden />}
        title={cause?.title ?? offlineReason(machine)}
        description={cause?.detail ?? `${machine} can't be reached right now.`}
        actions={
          <>
            <RetryButton onRetry={() => retry(machine)} />
            {removable(view) ? <RemoveMachineButton name={machine} onRemove={remove} /> : null}
          </>
        }
      />
    </div>
  );
}
