import { ChevronDown } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "../lib/cn.ts";
import { StatusIndicator, type AgentStatus } from "./status.tsx";

export interface AgentFoldProps {
  readonly name: string;
  readonly folded: boolean;
  readonly count: number;
  readonly blocked: number;
  readonly urgency: AgentStatus;
  readonly onToggle: () => void;
  readonly style?: CSSProperties;
  readonly className?: string;
}

const COUNT_TONE: Readonly<Record<AgentStatus, string>> = {
  blocked: "text-status-blocked-text",
  working: "text-status-working-text",
  done: "text-muted-foreground",
  idle: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const subAgents = (count: number): string => `${count} ${count === 1 ? "sub-agent" : "sub-agents"}`;

/** Accessible name for the fold toggle, announcing hidden count and any blocked sub-agents. */
export function agentFoldLabel(name: string, folded: boolean, count: number, blocked: number): string {
  if (!folded) return `Hide ${subAgents(count)} of ${name}`;
  const base = `Show ${subAgents(count)} of ${name}`;
  if (blocked <= 0) return base;
  return `${base}, ${blocked} ${blocked === 1 ? "needs you" : "need you"}`;
}

/**
 * Leading fold control for an agent row with sub-agents: a chevron when open, or the hidden count tinted by urgency
 * (plus a Needs you corner badge whenever any hidden sub-agent is blocked) when folded.
 */
export function AgentFold({ name, folded, count, blocked, urgency, onToggle, style, className }: AgentFoldProps) {
  const label = agentFoldLabel(name, folded, count, blocked);
  const neutralTone = !folded || (urgency !== "blocked" && urgency !== "working");
  return (
    <button
      type="button"
      data-agent-fold
      aria-expanded={!folded}
      aria-label={label}
      title={label}
      style={style}
      onClick={onToggle}
      className={cn(
        "pointer-events-auto relative inline-flex h-(--row) w-[18px] shrink-0 select-none items-center justify-center rounded-md outline-none",
        "transition-[background-color,color,transform] duration-(--duration-micro) ease-out active:scale-[0.97]",
        "hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        "after:absolute after:inset-y-0 after:-inset-x-1 coarse:after:inset-x-[min(-0.25rem,calc(50%-1.375rem))] coarse:after:min-h-11 coarse:after:min-w-11",
        folded ? COUNT_TONE[urgency] : "text-muted-foreground",
        neutralTone && "hover:text-foreground",
        className,
      )}
    >
      {folded ? (
        <>
          <span data-numeric className="text-2xs leading-none font-semibold tabular-nums">
            {count}
          </span>
          {blocked > 0 ? (
            <StatusIndicator
              status="blocked"
              className="pointer-events-none absolute top-0.5 right-0 size-2.5 [&>span]:text-[9px]"
            />
          ) : null}
        </>
      ) : (
        <ChevronDown aria-hidden className="size-3 shrink-0" />
      )}
    </button>
  );
}
