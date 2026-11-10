import { Button } from "@doriface/ui";
import { useRef, useState } from "react";
import { copyText, type CopyOutcome } from "./copy-text.ts";
import { crashDetails } from "./crash-details.ts";

export interface CopyDetailsProps {
  readonly error: unknown;
  /** The trigger's size: the crash screen's row of buttons or a region notice's small actions. */
  readonly size?: "sm" | "md";
}

/**
 * Copy details for a render error, with the details under it. When the clipboard is missing or refuses, the details
 * open with their text selected, so a long press or Ctrl+C still gets them.
 */
export function CopyDetails({ error, size = "md" }: CopyDetailsProps) {
  const [details] = useState(() =>
    crashDetails(error, { route: location.pathname, userAgent: navigator.userAgent, at: new Date() }),
  );
  const [copied, setCopied] = useState<CopyOutcome | null>(null);
  const [open, setOpen] = useState(false);
  const block = useRef<HTMLPreElement | null>(null);
  const select = (): void => {
    setOpen(true);
    const pre = block.current;
    if (pre === null) return;
    const range = document.createRange();
    range.selectNodeContents(pre);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  };
  return (
    <div className="flex w-full flex-col gap-2">
      <div>
        <Button
          variant="ghost"
          size={size}
          onClick={() => void copyText(details, navigator.clipboard ?? undefined, select).then(setCopied)}
        >
          {copied === "copied" ? "Copied" : "Copy details"}
        </Button>
      </div>
      {copied === "selected" ? (
        <p className="text-prose text-muted-foreground">Copying was refused: the details are selected below.</p>
      ) : null}
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Details</summary>
        <pre
          ref={block}
          className="mt-2 max-h-64 overflow-auto rounded-md bg-raised p-3 font-mono text-xs whitespace-pre-wrap select-text"
        >
          {details}
        </pre>
      </details>
    </div>
  );
}
