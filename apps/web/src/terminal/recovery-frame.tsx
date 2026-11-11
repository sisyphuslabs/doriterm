import type { ReactNode } from "react";
import type { Attachment } from "./use-terminal-attach.ts";
import { QuietBusy } from "./quiet-busy.tsx";
import { Unopened } from "./unopened.tsx";
import { Ended } from "./ended.tsx";

/** The renderer stays mounted through a failed attach, so the person's interaction can recover the same viewer. */
export function RecoveryFrame({
  attachment,
  children,
  error,
  closeLabel,
  className,
  onClose,
}: {
  readonly attachment: Attachment;
  readonly children: ReactNode;
  readonly error: string | null;
  readonly closeLabel: string;
  readonly className: string | undefined;
  readonly onClose: () => void;
}) {
  if (error !== null) return <p className="p-4 text-prose text-destructive">{error}</p>;
  if (attachment.restarting)
    return (
      <p role="status" className="p-4 text-prose text-muted-foreground">
        The program in this terminal is restarting…
      </p>
    );
  if (attachment.ended) return <Ended closeLabel={closeLabel} className={className} onClose={onClose} />;
  const interact = (event: { readonly target: EventTarget }): void => {
    // The explicit button owns its attempt and telemetry, including when reached by keyboard focus.
    if (!(event.target instanceof Element && event.target.closest("button"))) attachment.interact();
  };
  // Only what a person does counts: focus and scroll events also come from the view itself (focusing the pane it shows,
  // the renderer following its output), which would advance an automatic attempt and count it as an interaction.
  // Pressing into the pane, a key, paste, the wheel and a touch scroll are the person's.
  return (
    <div
      className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col"
      aria-busy={attachment.opening || attachment.reconnecting}
      onPointerDownCapture={interact}
      onKeyDownCapture={interact}
      onPasteCapture={attachment.interact}
      onWheelCapture={attachment.interact}
      onTouchMoveCapture={attachment.interact}
    >
      {children}
      {attachment.reconnecting ? (
        <QuietBusy label="Reconnecting terminal" text="Reconnecting…" className="absolute inset-0 z-10 bg-term-bg/95" />
      ) : attachment.unopened !== null ? (
        <Unopened why={attachment.unopened} className="absolute inset-0 z-10" onRetry={attachment.clearUnopened} />
      ) : attachment.opening ? (
        <QuietBusy label="Opening terminal" text="Opening…" className="absolute inset-0 z-10 bg-term-bg" />
      ) : null}
    </div>
  );
}
