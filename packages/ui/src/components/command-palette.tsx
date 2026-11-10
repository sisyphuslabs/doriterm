import { Search } from "lucide-react";
import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { fieldLabelClass } from "./input.tsx";
import { Kbd } from "./kbd.tsx";
import { overlaySurface } from "./overlay.ts";
import { agentCount, shownStatus, statusCounts, withStatus } from "./palette-status.ts";
import { SegmentedControl } from "./segmented-control.tsx";
import { STATUS_LABEL, StatusIndicator, type AgentStatus } from "./status.tsx";

const ALL = "all";

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly icon?: ReactNode;
  readonly keys?: readonly string[];
  /** Right-aligned secondary context, e.g. the machine. */
  readonly hint?: ReactNode;
  /** An agent's state, shown as its glyph and word after the hint. */
  readonly status?: AgentStatus;
  /** Listed but not runnable right now, as its disabled toolbar button; the hint says why. */
  readonly disabled?: boolean;
  /** Where the row lives (place and directory): the line under the list says it while the row is highlighted. */
  readonly where?: string;
}

export interface CommandPaletteProps {
  readonly commands: readonly Command[];
  readonly placeholder?: string;
  readonly defaultQuery?: string;
  readonly onRun?: (id: string) => void;
  /** Closes the palette; touch layouts show it as a Cancel button instead of the esc hint. */
  readonly onCancel?: () => void;
  readonly className?: string;
}

function matches(command: Command, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || command.label.toLowerCase().includes(q) || command.group.toLowerCase().includes(q);
}

/**
 * Type to filter, arrows to move, Enter to run, Escape (handled by the host dialog) to close.
 * The list is a listbox owned by the input through aria-activedescendant.
 */
export function CommandPalette({
  commands,
  placeholder = "Type a command or agent",
  defaultQuery = "",
  onRun,
  onCancel,
  className,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(defaultQuery);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<AgentStatus | null>(null);
  const listId = useId();
  const inputId = useId();
  const counts = useMemo(() => statusCounts(commands), [commands]);
  const status = shownStatus(counts, chosen);
  // A chosen state that emptied has fallen back to All: forget it, so a later agent in that state does not bring it back.
  if (chosen !== null && status === null) setChosen(null);
  const visible = useMemo(
    () => withStatus(commands, status).filter((command) => matches(command, query)),
    [commands, query, status],
  );
  const groups = useMemo(() => [...new Set(visible.map((command) => command.group))], [visible]);
  const current = visible[Math.min(active, visible.length - 1)];

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + visible.length) % Math.max(visible.length, 1));
    } else if (event.key === "Enter" && current !== undefined) {
      // The palette consumes its Enter: running a row can close it and move focus to a button,
      // which would otherwise take the same key press and act on it (reopening the palette).
      event.preventDefault();
      if (current.disabled !== true) onRun?.(current.id);
    }
  };

  return (
    <div className={cn(overlaySurface, "flex w-[min(40rem,100%)] flex-col overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-x-2.5 border-b border-border px-3">
        <label id={`${inputId}-label`} htmlFor={inputId} className={cn("basis-full pt-2", fieldLabelClass)}>
          Command
        </label>
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          id={inputId}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={current === undefined ? undefined : `${listId}-${current.id}`}
          aria-labelledby={`${inputId}-label`}
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="-mx-1.5 h-12 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-lg text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
        />
        <Kbd keys={["esc"]} />
        {onCancel === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={onCancel} className="-mr-2 hidden coarse:inline-flex">
            Cancel
          </Button>
        )}
      </div>
      {counts.length === 0 ? null : (
        <div className="border-b border-border px-3 py-2">
          <SegmentedControl<AgentStatus | typeof ALL>
            label="Show agents"
            compact
            value={status ?? ALL}
            onValueChange={(value) => {
              setChosen(value === ALL ? null : value);
              setActive(0);
            }}
            options={[
              { value: ALL, label: `All ${agentCount(commands)}` },
              ...counts.map(({ status: each, count }) => ({ value: each, label: `${STATUS_LABEL[each]} ${count}` })),
            ]}
          />
        </div>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        data-slot="palette-list"
        className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1.5"
      >
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-center text-prose text-muted-foreground">Nothing matches "{query}".</p>
        ) : (
          groups.map((group) => (
            <div key={group} role="group" aria-label={group} className="pb-4 coarse:pb-9">
              <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{group}</p>
              {visible
                .filter((command) => command.group === group)
                .map((command) => {
                  const selected = command.id === current?.id;
                  return (
                    <div
                      key={command.id}
                      id={`${listId}-${command.id}`}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={command.disabled}
                      aria-describedby={selected && command.where !== undefined ? `${listId}-where` : undefined}
                      onPointerMove={() => setActive(visible.indexOf(command))}
                      onClick={() => {
                        if (command.disabled !== true) onRun?.(command.id);
                      }}
                      className={cn(
                        "flex h-(--row) cursor-default items-center gap-2.5 rounded-md px-2 text-base text-foreground [&>svg:not([data-slot=spinner])]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
                        selected && "bg-selected",
                        command.disabled === true && "text-muted-foreground",
                      )}
                    >
                      {command.icon}
                      <span title={command.label} className="min-w-0 flex-1 truncate">
                        {command.label}
                      </span>
                      {command.hint === undefined ? null : (
                        <span
                          {...(typeof command.hint === "string" ? { title: command.hint } : {})}
                          className="min-w-0 max-w-[40%] truncate text-sm text-muted-foreground"
                        >
                          {command.hint}
                        </span>
                      )}
                      {command.status === undefined ? null : (
                        <span className="flex shrink-0 items-center gap-1.5 text-sm text-foreground">
                          <StatusIndicator status={command.status} decorative className="size-3" />
                          {STATUS_LABEL[command.status]}
                        </span>
                      )}
                      {command.keys === undefined ? null : <Kbd keys={command.keys} />}
                    </div>
                  );
                })}
            </div>
          ))
        )}
      </div>
      {current?.where === undefined ? null : (
        <p
          id={`${listId}-where`}
          title={current.where}
          data-slot="palette-where"
          className="truncate border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground"
        >
          {current.where}
        </p>
      )}
    </div>
  );
}
