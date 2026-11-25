import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";

export interface McpClientRowProps {
  readonly name: string;
  readonly connected: string;
  readonly onDisconnect: () => void;
  readonly details?: ReactNode;
}

/**
 * One connected MCP client row. Keeps one box in every state: device name, secondary connection text,
 * destructive ghost Disconnect action, and optional native disclosure for details.
 */
export function McpClientRow({ name, connected, onDisconnect, details }: McpClientRowProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-3.5 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="wrap-break-word text-base font-medium text-foreground">{name}</p>
          <p data-numeric="" className="mt-0.5 text-prose text-pretty text-muted-foreground">
            {connected}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            aria-label={`Disconnect ${name}`}
            className="text-destructive hover:text-destructive"
          >
            Disconnect
          </Button>
        </div>
      </div>
      {details === undefined ? null : (
        <details className="group">
          <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring coarse:min-h-11 coarse:min-w-11 coarse:px-1 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="size-3.5 shrink-0 transition-transform duration-(--duration-micro) group-open:rotate-90"
            />
            Details
          </summary>
          <div className="mt-2 rounded-md border border-border bg-raised p-3 text-xs text-muted-foreground">
            {details}
          </div>
        </details>
      )}
    </div>
  );
}
