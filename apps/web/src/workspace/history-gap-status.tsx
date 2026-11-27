import { Button, StatusBarItem } from "@doriface/ui";
import { History, X } from "lucide-react";
import { dismissHistoryGap, type HistoryGapCause, useHistoryGap } from "../terminal/history-gap-notice.ts";

const LABEL: Record<HistoryGapCause, string> = {
  reconnect: "Output from while disconnected may be missing",
  stream: "Output from while the terminal reattached may be missing",
};
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
