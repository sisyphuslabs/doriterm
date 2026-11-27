import type { HcConnection } from "@doriface/client";
import { Button, Sheet, Spinner } from "@doriface/ui";
import { History, TriangleAlert, WifiOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { dismissHistoryGap, type HistoryGapCause, useHistoryGap } from "../terminal/history-gap-notice.ts";
import { useMachineLine } from "../terminal/use-machine-line.ts";
import { useHostDownWhy } from "./host-down.ts";
import { useMachineDownWhy } from "./machine-down.tsx";
import { type ConnectionNotice, useConnectionNotice } from "./reconnect-status.tsx";
import { useMachinesContext } from "./use-machines.ts";

/** Which of the link's states the line says; also the attribute a spec finds it by. */
type Kind = "reconnecting" | "offline" | "host-down" | "machine-away" | "machine-down" | "history-gap";

interface Line {
  readonly kind: Kind;
  /** One short line: what is going on, never more than the header's second line holds. */
  readonly label: string;
  /** The whole explanation, in the sheet the line opens. */
  readonly detail: string;
  readonly action?: { readonly label: string; readonly run: () => unknown } | undefined;
}

/** The attribute each state carries, as the lines under the header carried it, so a spec finds it where it is now. */
const MARK: Record<Kind, string> = {
  reconnecting: "data-header-reconnecting",
  offline: "data-header-offline",
  "host-down": "data-host-down",
  "machine-away": "data-header-reconnecting",
  "machine-down": "data-machine-down",
  "history-gap": "data-history-gap-status",
};

const GAP_DETAIL: Record<HistoryGapCause, string> = {
  reconnect:
    "After the reconnect, output that scrolled off the screen while the connection was down is not in this terminal's history.",
  stream:
    "The terminal's stream ended and it attached again: output that scrolled off the screen meanwhile is not in its history.",
};

const tryNow = (): void => connectionStore.retryNow();

/** The workspace's own link, as the page says it: offline, why the host cannot be reached past the grace, or redialing. */
function linkLine(notice: ConnectionNotice, hostDown: string | null): Line {
  if (notice.offline)
    return { kind: "offline", label: "Offline", detail: notice.detail, action: { label: "Try again", run: tryNow } };
  if (hostDown !== null)
    return {
      kind: "host-down",
      label: "Can't connect",
      detail: hostDown,
      action: { label: "Try again", run: tryNow },
    };
  return { kind: "reconnecting", label: notice.label, detail: notice.detail };
}

const glyph = (kind: Kind): ReactNode => {
  if (kind === "reconnecting" || kind === "machine-away") return <Spinner />;
  if (kind === "offline") return <WifiOff aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
  if (kind === "history-gap") return <History aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
  return <TriangleAlert aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
};

/**
 * One state of the link in the header's second line, at that line's height: its words open a sheet with the whole
 * explanation, and its one action sits at the end of the line. The terminal under the header never gives up a row for
 * it, and nothing is drawn over the terminal (#2853, #2464).
 */
function LineView({ line }: { readonly line: Line }) {
  const [open, setOpen] = useState(false);
  const run = (): void => {
    setOpen(false);
    void line.action?.run();
  };
  return (
    // The line is the live region, outside its buttons: a button's children are presentational, so a status inside one
    // may never be announced (#2908 review).
    <div
      {...{ [MARK[line.kind]]: "" }}
      role="status"
      data-terminal-line={line.kind}
      className="flex min-w-0 items-center gap-1 text-xs leading-tight"
    >
      <Sheet
        title={line.label}
        side="bottom"
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 text-left text-foreground"
            aria-label={`${line.label}: details`}
          >
            {/* Under 360 px the words alone: the glyph's 16 px is what keeps the words and the action whole (#2908). */}
            <span className="contents max-[359px]:hidden">{glyph(line.kind)}</span>
            <span data-terminal-line-label className="min-w-0 truncate">
              {line.label}
            </span>
          </button>
        }
      >
        <p data-terminal-line-detail className="text-base text-pretty text-foreground">
          {line.detail}
        </p>
        {line.action === undefined ? null : (
          <Button className="mt-4 w-full" onClick={run}>
            {line.action.label}
          </Button>
        )}
      </Sheet>
      {line.action === undefined ? null : (
        // Text-high, so the line keeps the header's height. Its 44 pt touch target reaches up beside the title and down to the
        // header's own padding, never past the header: the terminal pane under it would take the taps (#2908 review).
        <button
          type="button"
          data-terminal-line-action
          onClick={() => void line.action?.run()}
          className="relative shrink-0 font-semibold text-foreground after:absolute after:-inset-x-2 after:-top-6 after:-bottom-1 after:content-['']"
        >
          {line.action.label}
        </button>
      )}
    </div>
  );
}

function GapOr({ address, fallback }: { readonly address: string; readonly fallback: ReactNode }) {
  const cause = useHistoryGap(address);
  if (cause === null) return fallback;
  return (
    <LineView
      line={{
        kind: "history-gap",
        label: "Some output may be missing",
        detail: GAP_DETAIL[cause],
        action: { label: "Dismiss", run: () => dismissHistoryGap(address) },
      }}
    />
  );
}

function MachineAway({ connection, machine }: { readonly connection: HcConnection; readonly machine: string }) {
  const { retry } = useMachinesContext();
  const why = useMachineDownWhy(connection, machine);
  if (why === null) {
    const sentence = `Reconnecting to ${machine}. Your typing will be sent.`;
    return <LineView line={{ kind: "machine-away", label: `Reconnecting to ${machine}`, detail: sentence }} />;
  }
  return (
    <LineView
      line={{
        kind: "machine-down",
        label: `Can't reach ${machine}`,
        detail: why,
        action: { label: "Try again", run: () => retry(machine) },
      }}
    />
  );
}

function MachineOrGap(props: {
  readonly connection: HcConnection;
  readonly address: string;
  readonly fallback: ReactNode;
}) {
  const away = useMachineLine(props.connection, props.address, true);
  if (away === null) return <GapOr address={props.address} fallback={props.fallback} />;
  return <MachineAway connection={props.connection} machine={away} />;
}

/**
 * The phone terminal header's second line: what the link is doing when that needs saying, else `fallback` (where the
 * terminal lives). The workspace's own link first (offline, its host past the grace, redialing), then the terminal's
 * machine line, then the note after a reconnect that may have lost output.
 */
export function PhoneTerminalLine(props: {
  readonly address: string;
  /** The workspace's connection while it is open; its machines' lines are read on it. */
  readonly connection?: HcConnection | undefined;
  readonly fallback: ReactNode;
}) {
  const notice = useConnectionNotice();
  const hostDown = useHostDownWhy();
  if (notice !== null) return <LineView line={linkLine(notice, hostDown)} />;
  if (props.connection === undefined) return <GapOr address={props.address} fallback={props.fallback} />;
  return <MachineOrGap connection={props.connection} address={props.address} fallback={props.fallback} />;
}
