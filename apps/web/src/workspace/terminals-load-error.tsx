import { Button, Notice } from "@doriface/ui";

/**
 * The core's first terminal answer failed: the lists cannot be drawn, and saying they are loading or empty would both be
 * untrue (#819). Try again asks the core once more. `title` names what the screen was drawing (a space, a terminal, #2532).
 */
export function TerminalsLoadError({
  cause,
  onRetry,
  title = "Could not load the agents",
}: {
  readonly cause: string;
  readonly onRetry: () => void;
  readonly title?: string;
}) {
  return (
    <Notice
      tone="error"
      title={title}
      className="mx-2 my-3"
      actions={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      The host did not answer with its terminals.
      <details className="mt-2">
        <summary className="cursor-pointer text-xs select-none">Details</summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-raised p-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
          {cause}
        </pre>
      </details>
    </Notice>
  );
}
