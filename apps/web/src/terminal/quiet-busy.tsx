import { cn, DelayedSpinner } from "@doriface/ui";

/**
 * A wait that says what it waits for, quietly: its short line at once, and a spinner only once the wait outlasts a second.
 * It is a status from the start, so assistive tech hears the label at once. The spinner keeps its box while it waits, so
 * its arrival moves nothing, and the parent places the whole state where the content would otherwise be.
 */
export function QuietBusy({ label, text, className }: { label: string; text: string; className?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "pointer-events-none flex items-center justify-center gap-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <DelayedSpinner />
      <span>{text}</span>
    </div>
  );
}
