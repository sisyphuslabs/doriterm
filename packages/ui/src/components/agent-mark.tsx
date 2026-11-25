import type { ReactElement } from "react";
import { cn } from "../lib/cn.ts";
import { AGENT_MARKS, hasAgentMark } from "./agent-marks.ts";

export interface AgentMarkProps {
  readonly kind: string;
  readonly size?: number;
  readonly className?: string;
  /** Beside a label that already names what runs (a tab's title): drawn for the eye only, with no name of its own. */
  readonly decorative?: boolean;
}

/** Single-colour mark for what a terminal runs, drawn in `currentColor` with its accessible name. */
export function AgentMark({ kind, size = 16, className, decorative = false }: AgentMarkProps): ReactElement | null {
  if (!hasAgentMark(kind)) return null;
  const entry = AGENT_MARKS[kind];
  if (entry === undefined) return null;
  const classes = cn("shrink-0", className);
  const named = decorative ? ({ "aria-hidden": true } as const) : ({ role: "img", "aria-label": entry.label } as const);
  switch (entry.from) {
    case "simple-icons":
      return (
        <svg
          {...named}
          viewBox="0 0 24 24"
          width={size}
          height={size}
          fill="currentColor"
          data-agent-mark={kind}
          className={classes}
        >
          <path d={entry.path} />
        </svg>
      );
    case "own":
      return (
        <svg
          {...named}
          viewBox={entry.viewBox}
          width={size}
          height={size}
          fill="currentColor"
          data-agent-mark={kind}
          className={classes}
        >
          <path d={entry.path} fillRule="evenodd" transform={entry.transform} />
        </svg>
      );
    case "lucide": {
      const Icon = entry.icon;
      return <Icon {...named} data-agent-mark={kind} width={size} height={size} className={classes} />;
    }
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}
