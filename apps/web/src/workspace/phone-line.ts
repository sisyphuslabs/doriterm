/**
 * The phone's one line under a screen's header: Reconnecting, Offline (with Retry) and the reconnect's history note
 * (with Dismiss) take its place in turn. Each reserves a small control's height, the button's or not, so the line keeps
 * one height through the hand-over and the terminal under it is not fitted again for it (#2257).
 */
export const PHONE_LINE = "flex shrink-0 items-start gap-2 border-b border-border bg-chrome px-4 py-2";

/** The line's text: a small control's height less the -my-1 its button sits in, so a line with no button is as tall. */
export const PHONE_LINE_TEXT =
  "flex min-h-[calc(var(--control-sm)-0.5rem)] min-w-0 flex-1 items-start gap-2 text-prose text-foreground";
