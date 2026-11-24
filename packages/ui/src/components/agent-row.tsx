import { Pin } from "lucide-react";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { AgentMark } from "./agent-mark.tsx";
import { hasAgentMark } from "./agent-marks.ts";
import { useRowFloors } from "./row-floors.ts";
import { STATUS_LABEL, StatusChip, StatusIndicator, type AgentStatus } from "./status.tsx";

/** One cell of a row's tree guides: "│" a continuing ancestor, "├" / "└" the row's own joint, "" a spent ancestor. */
export type AgentTreeGuide = "│" | "├" | "└" | "";

/** Width of one tree guide column in pixels. */
export const AGENT_TREE_GUIDE_PX = 14;

/** Width of the reserved fold-control column in pixels. */
export const AGENT_TREE_DISCLOSURE_PX = 18;

/** Left padding of an AgentRow (`px-2`), in pixels. */
const ROW_PADDING_LEFT_PX = 8;

/** X offset in pixels where the disclosure column starts for a row at `depth`, capped at `depthCap`. */
export const agentRowLead = (depth: number, depthCap = 3): number =>
  ROW_PADDING_LEFT_PX + AGENT_TREE_GUIDE_PX * Math.min(Math.max(0, depth), Math.max(0, depthCap));

function guideCells(guides: readonly AgentTreeGuide[] | undefined, drawn: number): readonly AgentTreeGuide[] {
  if (drawn <= 0) return [];
  const raw = guides ?? [];
  if (raw.length >= drawn) return raw.slice(raw.length - drawn);
  return [...Array.from<AgentTreeGuide>({ length: drawn - raw.length }).fill(""), ...raw];
}

function TreeGuideCell({ guide }: { readonly guide: AgentTreeGuide }) {
  return (
    <span className="relative h-full w-[14px] shrink-0">
      {guide === "│" || guide === "├" ? (
        <span className="absolute top-0 -bottom-px left-1/2 w-[1.5px] -translate-x-1/2 bg-border" />
      ) : null}
      {guide === "└" ? (
        <span className="absolute top-0 left-1/2 h-[calc(50%+0.75px)] w-[1.5px] -translate-x-1/2 bg-border" />
      ) : null}
      {guide === "├" || guide === "└" ? (
        <span className="absolute top-1/2 right-0 left-[calc(50%+0.75px)] h-[1.5px] -translate-y-1/2 bg-border" />
      ) : null}
    </span>
  );
}

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly status: AgentStatus;
  /** The tab name or the agent's title, after a middle dot. */
  readonly detail?: string;
  /** Shown for agents on another machine. */
  readonly machine?: string;
  /** Pre-formatted age: "<1m", "4m", "2h". */
  readonly age?: string;
  readonly icon?: ReactNode;
  /** The key of the mark drawn for what the agent runs. */
  readonly kind?: string;
  readonly pinned?: boolean;
  /** How far the agent's own todo list has got, when it draws one: `done` of `total`. */
  readonly todo?: { readonly done: number; readonly total: number };
  /** How deep the row sits under the agent that started it; absent or 0 for a top-level row. */
  readonly depth?: number;
  /** One cell per level above the row, as the list it is drawn in shapes them. */
  readonly guides?: readonly AgentTreeGuide[];
  /** The rows of the agent's subtree in the list it is drawn in: what a folded row counts. */
  readonly descendants?: number;
  /** The most urgent of the agent and its live sub-agents, a sub-agent's done read as idle. */
  readonly urgency?: AgentStatus;
}

/** The todo progress in words, for the label and the tooltip. */
export const todoLabel = (todo: { readonly done: number; readonly total: number }): string =>
  `${todo.done} of ${todo.total} tasks done`;

export interface AgentRowProps extends Omit<ComponentProps<"button">, "onSelect" | "children" | "className"> {
  readonly agent: Agent;
  readonly selected?: boolean;
  /** Use the "!" mark instead of the "Needs you" chip when a section header already says it. */
  readonly compactBlocked?: boolean;
  readonly onSelect?: (id: string) => void;
  /** The sidebar is an icon rail: the status glyph alone, the name and state as its label and tooltip. */
  readonly rail?: boolean;
  /** Maximum number of indented guide levels to draw (3 on desktop, 2 on phone). */
  readonly depthCap?: number;
  /** Reserve the 18 px disclosure column for the fold control. */
  readonly disclosure?: boolean;
  /** Name of the immediate parent agent, announced visually hidden after the name. */
  readonly parentName?: string;
  readonly className?: string;
}

/**
 * One agent in the sidebar or the phone list: status glyph, name, detail, machine, age. When the row is short, the
 * detail gives way first, then the machine, then the name, each down to five characters and an ellipsis (three for
 * the machine, then the detail, when the row cannot hold every five; see useRowFloors), with its full text as its
 * title. The age keeps a fixed column so ages line up.
 */
export function AgentRow({
  agent,
  selected = false,
  compactBlocked = false,
  onSelect,
  rail = false,
  depthCap = 3,
  disclosure = false,
  parentName,
  className,
  ref,
  ...props
}: AgentRowProps) {
  const quiet = agent.status === "idle" && !selected;
  const row = useRef<HTMLButtonElement | null>(null);
  const drawn = Math.min(Math.max(0, agent.depth ?? 0), Math.max(0, depthCap));
  const cells = guideCells(agent.guides, drawn);
  // The age and tree indent are in the key too: wider ages or deeper indents leave less room for the parts.
  const todo = agent.todo === undefined ? undefined : `${agent.todo.done}/${agent.todo.total}`;
  useRowFloors(
    row,
    [
      agent.name,
      agent.detail,
      agent.machine,
      agent.age,
      agent.kind,
      todo,
      drawn,
      disclosure ? "1" : "0",
      cells.join(""),
    ].join("\u0000"),
  );
  if (rail) {
    const label = [
      agent.name,
      STATUS_LABEL[agent.status],
      ...(agent.todo === undefined ? [] : [todoLabel(agent.todo)]),
    ].join(", ");
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect?.(agent.id)}
        className={cn(
          "flex h-(--row) w-full items-center justify-center rounded-md outline-none",
          "hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
          selected && "bg-selected",
          className,
        )}
      >
        <StatusIndicator status={agent.status} decorative />
      </button>
    );
  }
  return (
    <button
      {...props}
      ref={(node) => {
        row.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref !== null && ref !== undefined) ref.current = node;
        return undefined;
      }}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect?.(agent.id)}
      className={cn(
        "group flex h-(--row) w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none",
        "hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        selected && "bg-selected",
        className,
      )}
    >
      {drawn > 0 || disclosure ? (
        <span aria-hidden className="-mr-1.5 flex shrink-0 items-center self-stretch">
          <span aria-hidden data-tree-guides data-depth={drawn} className="flex h-full shrink-0">
            {cells.map((guide, index) => (
              <TreeGuideCell key={index} guide={guide} />
            ))}
          </span>
          {disclosure ? <span aria-hidden className="h-full w-[18px] shrink-0" /> : null}
        </span>
      ) : null}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {agent.status === "blocked" && !compactBlocked ? (
          <StatusIndicator status="blocked" decorative />
        ) : (
          <StatusIndicator status={agent.status} />
        )}
      </span>
      {agent.icon ??
        (agent.kind !== undefined && hasAgentMark(agent.kind) ? (
          // 14 px, held 2 px after the status glyph rather than the row's 10 px gap: the glyph draws inside its 16 px box, so
          // the two read as one cluster, and the mark costs the row's texts 16 px, which a narrow row with a long machine
          // name can give and still keep five characters of each (#2746).
          <AgentMark kind={agent.kind} size={14} className="-ml-2 text-muted-foreground" />
        ) : null)}
      <span
        title={agent.name}
        data-floor="name"
        className={cn("min-w-0 max-w-[50%] truncate", quiet ? "text-muted-foreground" : "text-foreground")}
      >
        {agent.name}
      </span>
      {parentName === undefined ? null : <span className="sr-only">, sub-agent of {parentName}</span>}
      {agent.detail === undefined ? null : (
        <>
          <span aria-hidden className="-mx-1.5 shrink-0 text-muted-foreground">
            ·
          </span>
          <span
            title={agent.detail}
            data-floor="detail"
            className="min-w-0 flex-auto shrink-3 truncate text-muted-foreground"
          >
            {agent.detail}
          </span>
        </>
      )}
      {agent.detail === undefined ? <span className="flex-1" /> : null}
      {agent.machine === undefined ? null : (
        <span
          title={agent.machine}
          data-floor="machine"
          data-row-meta
          className="min-w-0 max-w-[35%] shrink-2 truncate text-2xs text-muted-foreground"
        >
          {agent.machine}
        </span>
      )}
      {agent.todo === undefined ? null : (
        <span
          role="img"
          aria-label={todoLabel(agent.todo)}
          title={todoLabel(agent.todo)}
          data-numeric
          data-row-meta
          data-todo
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {todo}
        </span>
      )}
      {agent.status === "blocked" && !compactBlocked ? <StatusChip status="blocked" glyph={false} /> : null}
      {agent.pinned === true ? (
        // The same 14 px as the row's Unpin action that takes its place on hover, so the pin never jumps in size (#1562).
        <Pin role="img" aria-label="Pinned" data-row-meta className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      {agent.age === undefined ? null : (
        <time data-numeric data-row-meta className="min-w-7 shrink-0 text-right text-xs text-muted-foreground">
          {agent.age}
        </time>
      )}
    </button>
  );
}
