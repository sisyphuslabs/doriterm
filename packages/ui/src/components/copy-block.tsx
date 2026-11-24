import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";

export interface CopyBlockProps {
  readonly text: string;
  readonly label: string;
  readonly copyLabel?: string;
  readonly copied?: boolean;
  readonly onCopy: () => void;
  readonly className?: string;
}

const COPIED_LABEL = "Copied";

/**
 * A monospace block whose text wraps without scrolling sideways and preserves whitespace for multi-line JSON.
 * Its ghost copy button keeps one width between the idle and copied states.
 */
export function CopyBlock({ text, label, copyLabel, copied = false, onCopy, className }: CopyBlockProps) {
  const actionLabel = copyLabel ?? "Copy";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-raised p-3",
        className,
      )}
    >
      <pre className="m-0 max-w-full min-w-[min(16rem,100%)] flex-1 py-1 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-foreground select-all">
        <code>{text}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCopy}
        aria-label={`${actionLabel}: ${label}`}
        className="ml-auto shrink-0"
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span className="grid place-items-center">
          <span className={cn("col-start-1 row-start-1", copied && "invisible")} aria-hidden={copied || undefined}>
            {actionLabel}
          </span>
          <span className={cn("col-start-1 row-start-1", !copied && "invisible")} aria-hidden={!copied || undefined}>
            {COPIED_LABEL}
          </span>
        </span>
      </Button>
    </div>
  );
}
