import { ContextMenu, IconButton, MenuItem, cn, skipMenuHandler } from "@doriface/ui";
import { ArrowDown, ArrowUp, Monitor, Plus, Server } from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
  useRef,
} from "react";
import { currentPlatform } from "../keys/trigger.ts";
import { type MachineEntry, stateLabel } from "./machines.ts";
import { reorderKeys, reorderStep } from "./reorder-keys.ts";

const STATE_TONE: Readonly<Record<string, string>> = {
  unreachable: "text-status-blocked-text",
  needs_login: "text-status-blocked-text",
};

/** What a row needs to move: present only when the list has more than one machine. */
export interface RowReorder {
  readonly index: number;
  readonly count: number;
  readonly offset: number;
  readonly className: string;
  readonly dragging: boolean;
  readonly lifted: boolean;
  readonly menuOpen: boolean;
  readonly onMenuOpen: (open: boolean) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onClickCapture: (event: { stopPropagation(): void; preventDefault(): void }) => void;
  readonly touching: () => boolean;
  /** Moves this machine to index `to`, by its menu, a key or a drop. */
  readonly onMove: (to: number) => void;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
  readonly onFocus: () => void;
  /** Focus moving to another element forgets the row, so a later reorder does not pull focus back to it. */
  readonly onBlur: (event: FocusEvent<HTMLButtonElement>) => void;
}

export interface MachineRowProps {
  readonly machine: MachineEntry;
  readonly selected: boolean;
  readonly onOpen: (address: string) => void;
  readonly onNewOn: (machine: string) => void;
  readonly reorder: RowReorder | undefined;
}

/** One machine: open its first terminal, start one on it, or (with `reorder`) drag it, move it from its menu or a key. */
export function MachineRow({ machine, selected, onOpen, onNewOn, reorder }: MachineRowProps) {
  const Icon = machine.local ? Monitor : Server;
  const state = machine.local ? "this machine" : stateLabel(machine.state);
  const dim = machine.first === undefined && "opacity-45";
  const button = useRef<HTMLButtonElement | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (reorder === undefined) return;
    const step = reorderStep(event, currentPlatform());
    if (step === null) return;
    event.preventDefault();
    event.stopPropagation();
    const to = reorder.index + step;
    if (to >= 0 && to < reorder.count) reorder.onMove(to);
  };
  const row = (
    <div
      data-machine-row
      data-drag-id={machine.core}
      {...(reorder?.dragging === true ? { "data-dragging": "" } : {})}
      {...(reorder?.lifted === true ? { "data-lifted": "" } : {})}
      {...(reorder === undefined
        ? {}
        : {
            onPointerDown: reorder.onPointerDown,
            onClickCapture: reorder.onClickCapture,
            onTouchStart: skipMenuHandler,
            onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
              if (!reorder.touching()) return;
              skipMenuHandler(event);
              event.preventDefault();
            },
          })}
      style={reorder === undefined || reorder.offset === 0 ? undefined : { translate: `0 ${reorder.offset}px` }}
      className={cn(
        "group relative flex h-(--row) min-w-0 items-center rounded-md select-none",
        machine.first !== undefined && "hover:bg-hover",
        selected && "bg-selected",
        reorder?.lifted === true && "bg-raised shadow-overlay hover:bg-raised",
        reorder?.className,
      )}
    >
      <button
        ref={(element) => {
          button.current = element;
          reorder?.buttonRef(element);
        }}
        type="button"
        aria-current={selected ? "true" : undefined}
        aria-disabled={machine.first === undefined || undefined}
        onClick={() => machine.first !== undefined && onOpen(machine.first)}
        onKeyDown={onKeyDown}
        onFocus={reorder?.onFocus}
        onBlur={reorder?.onBlur}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-sm text-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-default"
      >
        <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", dim)} />
        <span title={machine.name} className={cn("min-w-0 flex-1 truncate", dim)}>
          {machine.name}
        </span>
        <span className={cn("shrink-0 text-2xs text-muted-foreground", STATE_TONE[machine.state])}>{state}</span>
        <span
          data-numeric
          aria-label={`${machine.live} terminals`}
          className={cn("w-4 shrink-0 text-right text-xs text-muted-foreground", dim)}
        >
          {machine.live}
        </span>
      </button>
      <IconButton
        label={`New terminal on ${machine.name}`}
        icon={<Plus />}
        data-drag-ignore
        className={cn(
          "mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          "data-disabled:opacity-0 group-hover:data-disabled:opacity-45 pointer-coarse:data-disabled:opacity-45",
        )}
        disabled={machine.state !== "connected"}
        onClick={() => onNewOn(machine.name)}
      />
    </div>
  );
  return reorder === undefined ? row : <RowMenu row={row} reorder={reorder} button={button} />;
}

interface RowMenuProps {
  readonly row: ReactElement;
  readonly reorder: RowReorder;
  readonly button: RefObject<HTMLButtonElement | null>;
}

function RowMenu({ row, reorder, button }: RowMenuProps) {
  const keys = reorderKeys(currentPlatform());
  return (
    <ContextMenu trigger={row} open={reorder.menuOpen} onOpenChange={reorder.onMenuOpen} finalFocus={button}>
      <MenuItem
        icon={<ArrowUp />}
        disabled={reorder.index === 0}
        keys={keys.up}
        onClick={() => reorder.onMove(reorder.index - 1)}
      >
        Move up
      </MenuItem>
      <MenuItem
        icon={<ArrowDown />}
        disabled={reorder.index === reorder.count - 1}
        keys={keys.down}
        onClick={() => reorder.onMove(reorder.index + 1)}
      >
        Move down
      </MenuItem>
    </ContextMenu>
  );
}
