import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { StatusIndicator } from "./status.tsx";

export interface GrantRowProps {
  readonly name: string;
  readonly kind: "browser" | "assistant";
  readonly rights: string;
  readonly state: "active" | "in-use" | "suspended" | "ended";
  readonly ends: string;
  readonly lastUsed?: string;
  readonly sessions?: number;
  readonly onRemove: () => void;
  readonly onResume?: () => void;
  readonly details?: ReactNode;
}

const KIND_LABEL: Readonly<Record<GrantRowProps["kind"], string>> = {
  browser: "Browser",
  assistant: "This browser's assistant",
};

/**
 * One attached MCP client row. Keeps the same box in every state; ended dims through colour tokens, never opacity.
 * `lastUsed` is the caller's words for when it was last used ("Last used 3 minutes ago", "Unused for 14 days").
 */
export function GrantRow({
  name,
  kind,
  rights,
  state,
  ends,
  lastUsed,
  sessions = 1,
  onRemove,
  onResume,
  details,
}: GrantRowProps) {
  const ended = state === "ended";
  // A suspended client leads with how long it sat unused, since that is why it is suspended.
  const metaParts = (state === "suspended" ? [lastUsed, ends] : [ends, lastUsed]).filter(
    (part): part is string => part !== undefined && part !== "",
  );
  const sessionLabel = sessions === 1 ? "1 session" : `${sessions} sessions`;

  return (
    <div className="flex flex-col gap-2 border-b border-border py-3.5 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-base font-medium", ended ? "text-muted-foreground" : "text-foreground")}>
              {name}
            </span>
            <Badge tone="neutral">{KIND_LABEL[kind]}</Badge>
            {state === "in-use" ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-working-text">
                <StatusIndicator status="working" decorative />
                <span data-numeric="">{sessionLabel}</span>
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-prose text-pretty text-muted-foreground">{rights}</p>
          <p data-numeric="" className="mt-0.5 text-xs text-muted-foreground">
            {metaParts.join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state === "suspended" ? (
            <Button variant="secondary" size="sm" onClick={onResume} aria-label={`Resume ${name}`}>
              Resume
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={`Remove ${name}`}
            className="text-destructive hover:text-destructive"
          >
            Remove
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
