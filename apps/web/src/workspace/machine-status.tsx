import type { MachineView } from "@doriface/protocol";
import type { HcConnection } from "@doriface/client";
import { StatusBarItem } from "@doriface/ui";
import { Unplug } from "lucide-react";
import { useMachineLine } from "../terminal/use-machine-line.ts";
import { machineCause } from "./machine-cause.ts";
import { machineOf } from "./model.ts";
import { AWAY } from "./reach.ts";
import { PHONE_LINE, PHONE_LINE_TEXT } from "./phone-line.ts";
import { useConnectionNotice } from "./reconnect-status.tsx";
import { RetryButton } from "./retry-button.tsx";
import { useMachinesContext } from "./use-machines.ts";

/** What to say about a terminal's added machine while it is not usable: the same words wherever it is shown. */
export interface MachineNotice {
  readonly machine: string;
  /** The short words: the desktop bar's label. */
  readonly label: string;
  /** The whole sentence: the bar's tooltip and the phone's line. */
  readonly text: string;
  /** Past the grace, the machine is offline: a still glyph and a way to dial it now. */
  readonly offline: boolean;
}

/**
 * The notice for the added machine `address` is on, or null while it is reachable or the terminal is this core's own.
 * While hc redials its line, keys wait for it (HeldInput, #1489); past the grace (#904) it is offline, in the words
 * machineCause gives it (#2003: a machine that is gone is said where a host that is gone is, never over the terminal).
 */
export function useMachineNotice(connection: HcConnection, address: string | null): MachineNotice | null {
  const machine = address === null ? undefined : machineOf(address);
  const { views } = useMachinesContext();
  const away = useMachineLine(connection, address ?? "", machine !== undefined);
  // While the connection itself is down, its notice says so; the machine is reached through it.
  const connectionDown = useConnectionNotice() !== null;
  if (machine === undefined || connectionDown) return null;
  const view = views.find((entry) => entry.name === machine);
  if (view !== undefined && AWAY.has(view.state)) {
    const cause = machineCause(view);
    const label = cause?.title ?? `${machine} is offline`;
    return { machine, label, text: `${label}. ${cause?.detail ?? ""}`.trim(), offline: true };
  }
  if (away === null) return null;
  const text = `Reconnecting to ${away}. Your typing will be sent.`;
  return { machine, label: text, text, offline: false };
}

/** The desktop status bar's item for the focused terminal's machine, beside the connection's own (ReconnectStatus). */
export function MachineStatus({
  connection,
  address,
}: {
  readonly connection: HcConnection;
  readonly address: string | null;
}) {
  const notice = useMachineNotice(connection, address);
  const { retry } = useMachinesContext();
  if (notice === null) return null;
  return (
    <span role="status" className="flex min-w-0 items-center gap-2" title={notice.text}>
      <StatusBarItem icon={<Unplug aria-hidden />}>
        <span className="truncate text-foreground">{notice.label}</span>
      </StatusBarItem>
      {notice.offline ? <RetryButton size="sm" onRetry={() => retry(notice.machine)} /> : null}
    </span>
  );
}

/** The phone's line for the open terminal's machine, under its header where the connection's own line goes. */
export function MachineLine({ connection, address }: { readonly connection: HcConnection; readonly address: string }) {
  const notice = useMachineNotice(connection, address);
  const { retry } = useMachinesContext();
  if (notice === null) return null;
  return (
    <div className={PHONE_LINE}>
      <p
        role="status"
        className={`${PHONE_LINE_TEXT} [&_svg:not([data-slot=spinner])]:mt-0.5 [&_svg:not([data-slot=spinner])]:size-4 [&_svg:not([data-slot=spinner])]:shrink-0 [&_svg:not([data-slot=spinner])]:text-muted-foreground`}
      >
        <Unplug aria-hidden />
        <span className="min-w-0 text-pretty break-words">{notice.text}</span>
      </p>
      {notice.offline ? (
        <RetryButton size="sm" className="-my-1 shrink-0" onRetry={() => retry(notice.machine)} />
      ) : null}
    </div>
  );
}

/** The short title for a machine whose terminals read offline, as machineCause gives it: offline, or a login it needs. */
export function offlineTitle(name: string, views: readonly MachineView[]): string {
  const view = views.find((entry) => entry.name === name);
  return (view === undefined ? undefined : machineCause(view)?.title) ?? `${name} is offline`;
}

/** A split pane's header note for its machine while offline: the title machineCause gives (#2375 review). */
export function PaneOfflineNote({ machine }: { readonly machine: string }) {
  const { views } = useMachinesContext();
  return <span className="shrink-0 text-muted-foreground">· {offlineTitle(machine, views)}</span>;
}
