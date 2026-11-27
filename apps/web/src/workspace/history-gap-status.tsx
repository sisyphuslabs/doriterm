import { Button, StatusBarItem } from "@doriface/ui";
import { History, X } from "lucide-react";
import { PHONE_LINE, PHONE_LINE_TEXT } from "./phone-line.ts";
import { dismissHistoryGap, type HistoryGapCause, useHistoryGap } from "../terminal/history-gap-notice.ts";

const LABEL: Record<HistoryGapCause, string> = {
  reconnect: "Output from while disconnected may be missing",
  stream: "Output from while the terminal reattached may be missing",
};
/** The phone's line is one line at 390 px, so it hands over from "Reconnecting" at the same height (#2257). */
const SHORT = "Some output may be missing";
const DETAIL: Record<HistoryGapCause, string> = {
  reconnect:
    "After the reconnect, output that scrolled off the screen while the connection was down is not in this terminal's history.",
  stream:
    "The terminal's stream ended and it attached again: output that scrolled off the screen meanwhile is not in its history.",
};

const Dismiss = ({ address, className }: { readonly address: string; readonly className: string }) => (
  <Button
    variant="ghost"
    size="sm"
    aria-label="Dismiss"
    title="Dismiss"
    onClick={() => dismissHistoryGap(address)}
    className={className}
  >
    <X aria-hidden className="size-3.5" />
  </Button>
);

/** The desktop status bar's note for the focused terminal, after it may have lost output (#2033, #2257). */
export function HistoryGapStatus({ address }: { readonly address: string | null }) {
  const cause = useHistoryGap(address);
  if (address === null || cause === null) return null;
  return (
    <span role="status" data-history-gap-status className="flex min-w-0 items-center gap-1" title={DETAIL[cause]}>
      <StatusBarItem icon={<History aria-hidden />}>
        <span className="truncate text-foreground">{LABEL[cause]}</span>
      </StatusBarItem>
      <Dismiss address={address} className="h-5 px-1 text-muted-foreground" />
    </span>
  );
}

/** The phone terminal's line under its header, where it says the connection notice, for the same note (#2033, #2257). */
export function HistoryGapLine({ address }: { readonly address: string }) {
  const cause = useHistoryGap(address);
  if (cause === null) return null;
  return (
    <div className={PHONE_LINE}>
      <p role="status" data-history-gap-status className={PHONE_LINE_TEXT} title={DETAIL[cause]}>
        <History aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{SHORT}</span>
        <span className="sr-only">{`: ${DETAIL[cause]}`}</span>
      </p>
      <Dismiss address={address} className="-my-1 shrink-0 text-muted-foreground" />
    </div>
  );
}
