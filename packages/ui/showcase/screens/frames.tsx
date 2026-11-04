import type { ReactNode } from "react";
import { TerminalPreview, cn, type TerminalLine } from "../../src/index.ts";

/**
 * A phone-sized viewport drawn on the desktop board, so phone screens can be reviewed beside each other.
 * It uses the coarse-pointer density and an iPhone 14's safe areas, and draws the home indicator.
 */
export function PhoneFrame({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <figure className="flex flex-col items-center gap-3">
      <div
        data-density="coarse"
        data-insets="phone"
        className="relative h-[844px] w-[390px] overflow-hidden rounded-[2.5rem] border border-border bg-background text-base shadow-overlay"
      >
        {children}
        <span
          aria-hidden
          className="absolute bottom-2 left-1/2 h-1.5 w-32 -translate-x-1/2 rounded-full bg-foreground/80"
        />
      </div>
      <figcaption className="text-sm text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

/** One step of a flow on a review board. On phones the board is the step itself. */
export function BoardFrame({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section aria-label={label} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <p className="hidden text-sm text-muted-foreground lg:block">{label}</p>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface lg:rounded-xl lg:border lg:border-border">
        {children}
      </div>
    </section>
  );
}

/** A cropped terminal for a states board: what a mockup pins over it (`overlay`) or docks under it (`dock`). */
export function TerminalCrop({
  lines,
  overlay,
  dock,
  header,
  className,
}: {
  readonly lines: readonly TerminalLine[];
  readonly overlay?: ReactNode;
  readonly dock?: ReactNode;
  readonly header?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex h-80 min-h-0 flex-col overflow-hidden bg-card", className)}>
      {header}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TerminalPreview lines={lines} cursor label="Terminal output" className="flex-1 coarse:text-[0.75rem]" />
        {overlay === undefined ? null : <div className="absolute inset-x-2 top-2 mx-auto max-w-[40rem]">{overlay}</div>}
      </div>
      {dock}
    </div>
  );
}

/** A labelled state on a phone-width page, where the board's frame labels are hidden. */
export function StateSection({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col border-t border-border">
      <p className="px-4 pt-4 pb-2 text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </section>
  );
}
