import { Button, Notice } from "@doriface/ui";

/**
 * The core's first terminal answer failed: the lists cannot be drawn, and saying they are loading or empty would both be
 * untrue (#819). Try again asks the core once more.
 */
export function TerminalsLoadError({ cause, onRetry }: { readonly cause: string; readonly onRetry: () => void }) {
  return (
    <Notice
      tone="error"
      title="Could not load the agents"
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
