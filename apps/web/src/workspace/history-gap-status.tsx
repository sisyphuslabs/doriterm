import { Button, StatusBarItem } from "@doriface/ui";
import { History, X } from "lucide-react";
import { dismissHistoryGap, useHistoryGapNoted } from "../terminal/history-gap-notice.ts";

const LABEL = "Output from while disconnected may be missing";
const DETAIL =
  "After the reconnect, output that scrolled off the screen while the connection was down is not in the terminal's history.";

const Dismiss = ({ className }: { readonly className: string }) => (
  <Button
    variant="ghost"
    size="sm"
    aria-label="Dismiss"
    title="Dismiss"
    onClick={dismissHistoryGap}
    className={className}
  >
    <X aria-hidden className="size-3.5" />
  </Button>
);

/** The desktop status bar's note, beside Connected, after a reconnect that may have lost output (#2033). */
export function HistoryGapStatus() {
  if (!useHistoryGapNoted()) return null;
  return (
    <span role="status" data-history-gap-status className="flex min-w-0 items-center gap-1" title={DETAIL}>
      <StatusBarItem icon={<History aria-hidden />}>
        <span className="truncate text-foreground">{LABEL}</span>
      </StatusBarItem>
      <Dismiss className="h-5 px-1 text-muted-foreground" />
    </span>
  );
}

/** The phone terminal's line under its header, where it says the connection notice, for the same note (#2033). */
export function HistoryGapLine() {
  if (!useHistoryGapNoted()) return null;
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-border bg-chrome px-4 py-2">
      <p
        role="status"
        data-history-gap-status
        className="flex min-w-0 flex-1 items-start gap-2 text-prose text-foreground"
      >
        <History aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 text-pretty break-words" title={DETAIL}>
          {LABEL}
        </span>
      </p>
      <Dismiss className="-my-1 shrink-0 text-muted-foreground" />
    </div>
  );
}
