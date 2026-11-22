import { Notice } from "@doriface/ui";
import { machineCause } from "./machine-cause.ts";
import { RemoveMachineButton, removable } from "./remove-machine.tsx";
import { RetryButton } from "./retry-button.tsx";
import { useMachinesContext } from "./use-machines.ts";

/**
 * A machine's problem under its header, with Try again and, for a machine added by hand, Remove beside it (#2456). A
 * routine redial raises no alarm (#1686, #2464): inside its reconnect grace the header alone reads reconnecting; the
 * notice with why and its actions comes once the grace is over and it reads offline.
 */
export function MachineNotice({ name }: { readonly name: string }) {
  const { views, retry, remove } = useMachinesContext();
  const view = views.find((one) => one.name === name);
  const cause =
    view === undefined || view.state === "connecting" || view.state === "reconnecting" ? undefined : machineCause(view);
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
