import type { HcConnection } from "@doriface/client";
import type { MachineView } from "@doriface/protocol";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { machineLines } from "../terminal/machine-lines.ts";
import { machineCause } from "./machine-cause.ts";
import { ACTION_GRACE_MS } from "./machine-grace.ts";
import { firstSentence } from "./first-sentence.ts";
import { PHONE_LINE, PHONE_LINE_TEXT } from "./phone-line.ts";
import { RetryButton } from "./retry-button.tsx";
import { useMachinesContext } from "./use-machines.ts";

/**
 * Why a machine's line is down, once it has been down for the grace (#2464): hc's `why` in the words the machine's
 * offline notice uses, while hc keeps redialing. Null within the grace, and while the machine is not read down.
 */
export function machineDownWhy(
  line: Pick<MachineView, "name" | "state" | "why"> | undefined,
  downFor: number | undefined,
): string | null {
  if (line === undefined || downFor === undefined || downFor < ACTION_GRACE_MS) return null;
  // A redial under way reads connecting; the cause is the line's last refusal, said as the offline notice says it.
  return machineCause({ name: line.name, state: "unreachable", why: line.why ?? null })?.detail ?? null;
}

/** machineDownWhy for a machine on that connection as its line is read now, moved on when the grace ends. */
export function useMachineDownWhy(connection: HcConnection, machine: string): string | null {
  const subscribe = useCallback((changed: () => void) => machineLines.subscribe(changed), []);
  const since = useSyncExternalStore(subscribe, () => machineLines.downSince(connection, machine));
  const line = useSyncExternalStore(subscribe, () => machineLines.line(connection, machine));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (since === undefined) return undefined;
    const left = since + ACTION_GRACE_MS - Date.now();
    if (left <= 0) return setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), left);
    return () => clearTimeout(timer);
  }, [since]);
  return machineDownWhy(line, since === undefined ? undefined : Math.max(now, Date.now()) - since);
}

/**
 * Past the grace, why the machine of the terminal in view is down, as text beside its one action (#2464): in the status
 * bar on a desktop, in its own line under the header on a phone. hc keeps redialing meanwhile; the machine reads offline
 * only once its longer redial grace is over (#904), and no warning is raised before then (#1686). Never over the terminal.
 */
export function MachineDownHelp({
  connection,
  machine,
  phone = false,
}: {
  readonly connection: HcConnection;
  readonly machine: string;
  readonly phone?: boolean;
}) {
  const { retry } = useMachinesContext();
  const why = useMachineDownWhy(connection, machine);
  if (why === null) return null;
  const tryNow = (): Promise<void> => retry(machine);
  if (phone) {
    return (
      <div className={PHONE_LINE} data-machine-down>
        <p role="status" className={PHONE_LINE_TEXT}>
          <span className="min-w-0 text-pretty break-words">{why}</span>
        </p>
        <RetryButton size="sm" className="-my-1 shrink-0" onRetry={tryNow} />
      </div>
    );
  }
  return (
    <span data-machine-down className="flex shrink-0 items-center gap-2">
      <span role="status" className="text-xs whitespace-nowrap text-foreground" title={why} aria-label={why}>
        {firstSentence(why)}
      </span>
      <RetryButton size="sm" onRetry={tryNow} />
    </span>
  );
}
