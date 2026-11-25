import { cn, Spinner, useShownAfter } from "@doriface/ui";

/**
 * A wait that says what it waits for, quietly: nothing while the wait is under a second, then its line and a spinner,
 * kept at least half a second so they never blink (#2768). It is a status from the start, so assistive tech hears the
 * label at once, and the parent places the whole state where the content would otherwise be.
 */
export function QuietBusy({ label, text, className }: { label: string; text: string; className?: string }) {
  const shown = useShownAfter(true);
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "pointer-events-none flex items-center justify-center gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {shown ? (
        <>
          <Spinner />
          <span>{text}</span>
        </>
      ) : null}
    </div>
  );
}
