import { Notice } from "@doriface/ui";
import { machineCause } from "./machine-cause.ts";
import { RemoveMachineButton, removable } from "./remove-machine.tsx";
import { RetryButton } from "./retry-button.tsx";
import { useMachinesContext } from "./use-machines.ts";

/**
 * A machine's problem under its header, including why creation is unavailable during its reconnect grace, with Try
 * again and, for a machine added by hand, Remove beside it (#2456).
 */
export function MachineNotice({ name }: { readonly name: string }) {
  const { views, retry, remove } = useMachinesContext();
  const view = views.find((one) => one.name === name);
  const cause = view === undefined || view.state === "connecting" ? undefined : machineCause(view);
  if (cause === undefined) return null;
  const retryable = cause.retryless !== true;
  const canRemove = removable(view);
  return (
    <Notice tone="warning" className="mx-1 mt-1" title={cause.title}>
      {cause.detail}
      {retryable || canRemove ? (
        <span className="mt-2 flex flex-wrap gap-2">
          {retryable ? <RetryButton size="sm" onRetry={() => retry(name)} /> : null}
          {canRemove ? <RemoveMachineButton size="sm" name={name} onRemove={remove} /> : null}
        </span>
      ) : null}
    </Notice>
  );
}
