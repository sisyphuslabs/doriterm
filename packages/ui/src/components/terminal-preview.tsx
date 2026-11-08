import { cn } from "../lib/cn.ts";
import { FIND_CURRENT_CLASS, FIND_MATCH_CLASS } from "./find-bar.tsx";

/** One run of text in one ANSI colour (0-15), or the default foreground when omitted. */
export interface TerminalSpan {
  readonly text: string;
  readonly color?: number;
  readonly bold?: boolean;
  readonly dim?: boolean;
  /** A find match drawn over the text, as the live terminal draws it. */
  readonly mark?: "match" | "current";
}

export type TerminalLine = readonly TerminalSpan[];

export interface TerminalPreviewProps {
  readonly lines: readonly TerminalLine[];
  /** Draws a block cursor after the last line. */
  readonly cursor?: boolean;
  readonly label: string;
  readonly className?: string;
}

/**
 * A static, ANSI-coloured terminal surface styled with the same --term-* variables the live
 * libghostty renderer reads. It stands in for the live terminal in mockups and previews.
 */
export function TerminalPreview({ lines, cursor = false, label, className }: TerminalPreviewProps) {
  return (
    <pre
      role="img"
      aria-label={label}
      data-slot="terminal-viewport"
      className={cn(
        "m-0 min-h-0 overflow-auto bg-(--term-bg) px-3.5 py-3 font-mono text-[0.8125rem] leading-[1.45] break-all whitespace-pre-wrap text-(--term-fg)",
        className,
      )}
    >
      {lines.map((line, row) => (
        <div key={row}>
          {line.length === 0 ? "\u00a0" : null}
          {line.map((span, index) => (
            <span
              key={`${row}-${index}`}
              style={span.color === undefined ? undefined : { color: `var(--term-color-${span.color})` }}
              className={cn(
                span.bold === true && "font-bold",
                span.dim === true && "text-(--term-faint)",
                span.mark === "match" && FIND_MATCH_CLASS,
                span.mark === "current" && FIND_CURRENT_CLASS,
              )}
            >
              {span.text}
            </span>
          ))}
          {cursor && row === lines.length - 1 ? (
            <span
              aria-hidden
              className="ml-px inline-block h-[1.1em] w-[0.6em] translate-y-[0.15em] bg-(--term-cursor)"
            />
          ) : null}
        </div>
      ))}
    </pre>
  );
}
