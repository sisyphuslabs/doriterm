import {
  Button,
  IconButton,
  Notice,
  RowDropCaret,
  RowDropIndicator,
  rowPlacement,
  SidebarSection,
  cn,
  useListDrag,
} from "@doriface/ui";
import { Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { machineCause } from "./machine-cause.ts";
import { MachineRow, type RowReorder } from "./machine-row.tsx";
import { type MachineEntry, onlyThisMachine } from "./machines.ts";
import { RetryButton } from "./retry-button.tsx";
import { useMachinesContext } from "./use-machines.ts";

export interface MachineListProps {
  readonly entries: readonly MachineEntry[];
  /** The id of the machine the active terminal is on. */
  readonly activeMachine: string | undefined;
  readonly onOpen: (address: string) => void;
  readonly onNewOn: (machine: string) => void;
  readonly listError?: string | undefined;
  readonly onAdd: () => void;
  readonly className?: string;
}

/** A machine this list moved, by any path; counted so a second move to the same place is still announced. */
interface Moved {
  readonly core: string;
  readonly count: number;
}

/**
 * Every machine this core reaches, in the order the person put them (this one, then the added ones by name, until they
 * move one), with state and terminals. With two or more a row drags to a new place, and its menu and keys move it too.
 */
export function MachineList({
  entries,
  activeMachine,
  onOpen,
  onNewOn,
  listError,
  onAdd,
  className,
}: MachineListProps) {
  const alone = onlyThisMachine(entries);
  const add = alone ? undefined : (
    <IconButton label="Add a machine" icon={<Plus />} onClick={onAdd} className="-mr-1" />
  );
  const { views, retry, moveMachine } = useMachinesContext();
  const causes = views.flatMap((view) => {
    // A redial in progress is routine: the row already says connecting, so only a problem gets a notice.
    const cause = view.state === "connecting" ? undefined : machineCause(view);
    return cause === undefined ? [] : [{ machine: view.name, ...cause }];
  });
  const list = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focused = useRef<string | null>(null);
  const [moved, setMoved] = useState<Moved | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const movable = entries.length > 1;
  const move = (core: string, to: number): void => {
    setMoved((last) => ({ core, count: (last?.count ?? 0) + 1 }));
    moveMachine(core, to);
  };
  const { drag, settle, lifted, touching, onPointerDown, onClickCapture } = useListDrag(
    list,
    entries.map((machine) => machine.core),
    {
      onMove: movable ? move : undefined,
      onStart: () => setMenuFor(null),
      onHoldRelease: (core, x, y) => {
        const row = list.current?.querySelector(`[data-drag-id="${CSS.escape(core)}"]`);
        row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      },
    },
  );

  // Reordering moves the focused row in the DOM, which drops its focus; it goes straight back.
  useLayoutEffect(() => {
    if (moved === null || focused.current !== moved.core) return;
    const button = buttons.current.get(moved.core);
    if (button !== undefined && document.activeElement !== button) button.focus();
  }, [moved, entries]);

  const movedAt = moved === null ? -1 : entries.findIndex((machine) => machine.core === moved.core);
  const movedMachine = entries[movedAt];
  // The count's parity changes the text each time, so a second move to the same place is still read out.
  const announcement =
    moved === null || movedMachine === undefined
      ? ""
      : `Moved ${movedMachine.name} to position ${movedAt + 1} of ${entries.length}${moved.count % 2 === 0 ? "" : "\u00a0"}`;

  const reorderOf = (machine: MachineEntry, index: number): RowReorder | undefined => {
    if (!movable) return undefined;
    const place = rowPlacement(machine.core, index, drag, settle);
    return {
      index,
      count: entries.length,
      offset: place.offset,
      className: place.className,
      dragging: drag?.id === machine.core,
      lifted: lifted === machine.core,
      menuOpen: menuFor === machine.core,
      onMenuOpen: (open) => setMenuFor(open ? machine.core : null),
      onPointerDown: (event) => onPointerDown(event, machine.core, index),
      onClickCapture,
      touching,
      onMove: (to) => {
        focused.current = machine.core;
        move(machine.core, to);
      },
      buttonRef: (element) => {
        if (element === null) buttons.current.delete(machine.core);
        else buttons.current.set(machine.core, element);
      },
      onFocus: () => {
        focused.current = machine.core;
      },
    };
  };

  return (
    <SidebarSection
      ref={list}
      title="Machines"
      count={entries.length}
      {...(add === undefined ? {} : { action: add })}
      className={cn("relative", className)}
    >
      {drag === null ? null : <RowDropIndicator drag={drag} />}
      {drag === null ? null : <RowDropCaret drag={drag} />}
      {entries.map((machine, index) => (
        <MachineRow
          key={machine.core}
          machine={machine}
          selected={machine.id === activeMachine}
          onOpen={onOpen}
          onNewOn={onNewOn}
          reorder={reorderOf(machine, index)}
        />
      ))}
      {alone ? (
        <Button variant="ghost" onClick={onAdd} className="h-(--row) justify-start gap-2.5 px-2 text-sm">
          <Plus aria-hidden className="size-4 text-muted-foreground" />
          Add a machine
        </Button>
      ) : null}
      {causes.map(({ machine, title, detail }) => (
        <Notice key={machine} tone="warning" className="mx-1 mt-1" title={title}>
          {detail}
          <RetryButton size="sm" className="mt-2 flex" onRetry={() => retry(machine)} />
        </Notice>
      ))}
      {listError === undefined ? null : (
        <Notice tone="error" className="mx-1 mt-1" title="Could not list the machines">
          {listError}
        </Notice>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </SidebarSection>
  );
}
