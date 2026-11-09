import { useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { PinSymbol } from "./pin-symbol.tsx";
import { useRowFloors } from "./row-floors.ts";
import { STATUS_LABEL, StatusChip, StatusIndicator, type AgentStatus } from "./status.tsx";

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
  readonly pinned?: boolean;
  /** How far the agent's own todo list has got, when it draws one: `done` of `total`. */
  readonly todo?: { readonly done: number; readonly total: number };
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
  /** A persistent action draws the pin on fine pointers; keep its space reserved, and the mark on touch. */
  readonly pinInActions?: boolean;
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
  pinInActions = false,
  className,
  ref,
  ...props
}: AgentRowProps) {
  const quiet = agent.status === "idle" && !selected;
  const row = useRef<HTMLButtonElement | null>(null);
  // The age is in the key too: a wider age (59m after <1m) leaves less room for the parts.
  const todo = agent.todo === undefined ? undefined : `${agent.todo.done}/${agent.todo.total}`;
  useRowFloors(row, [agent.name, agent.detail, agent.machine, agent.age, todo].join("\u0000"));
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
      <span className="flex size-4 shrink-0 items-center justify-center">
        {agent.status === "blocked" && !compactBlocked ? (
          <StatusIndicator status="blocked" decorative />
        ) : (
          <StatusIndicator status={agent.status} />
        )}
      </span>
      {agent.icon}
      <span
        title={agent.name}
        data-floor="name"
        className={cn("min-w-0 max-w-[50%] truncate", quiet ? "text-muted-foreground" : "text-foreground")}
      >
        {agent.name}
      </span>
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
        <span
          data-row-meta
          className={cn("shrink-0 text-muted-foreground", pinInActions && "invisible coarse:visible")}
        >
          <PinSymbol pinned label="Pinned" />
        </span>
      ) : null}
      {agent.age === undefined ? null : (
        <time data-numeric data-row-meta className="min-w-7 shrink-0 text-right text-xs text-muted-foreground">
          {agent.age}
        </time>
      )}
    </button>
  );
}
