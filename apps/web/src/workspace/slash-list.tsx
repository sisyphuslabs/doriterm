import { cn, DelayedSpinner } from "@doriface/ui";
import type { SlashCommand } from "./omo-commands.ts";
import type { CommandList } from "./use-omo-commands.ts";

export interface SlashListProps {
  readonly id: string;
  readonly list: CommandList;
  /** The commands the typed word names, in the order shown. */
  readonly matches: readonly SlashCommand[];
  readonly typed: string;
  readonly active: number;
  readonly onActive: (index: number) => void;
  readonly onPick: (command: SlashCommand) => void;
}

export const optionId = (list: string, index: number): string => `${list}-${index}`;

/**
 * OmO's commands over the phone's Type field while a `/word` is in it (#2658): a listbox the field drives as a combobox,
 * so the field keeps the focus and the soft keyboard stays up while more letters narrow it. It sits in the keys bar,
 * not in a sheet: a sheet would take the focus, and the keyboard with it, at the first `/`.
 */
export function SlashList({ id, list, matches, typed, active, onActive, onPick }: SlashListProps) {
  return (
    <div className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-overlay">
      <p id={`${id}-label`} className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
        OmO commands
      </p>
      <div
        id={id}
        role="listbox"
        aria-labelledby={`${id}-label`}
        className="max-h-[min(18rem,40dvh)] overflow-y-auto p-1"
      >
        {list.kind === "ready" && matches.length > 0 ? (
          matches.map((command, index) => (
            <div
              key={command.name}
              id={optionId(id, index)}
              role="option"
              aria-selected={index === active}
              // A press that moved focus off the field would put the phone's keyboard down.
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => onActive(index)}
              onClick={() => onPick(command)}
              className={cn(
                "flex min-h-11 cursor-default flex-col justify-center rounded-md px-2.5 py-1 text-foreground",
                index === active && "bg-selected",
              )}
            >
              <span className="font-mono text-base">/{command.name}</span>
              {command.description === "" ? null : (
                <span className="line-clamp-1 text-sm text-muted-foreground">{command.description}</span>
              )}
            </div>
          ))
        ) : (
          <p role="status" className="flex min-h-11 items-center gap-2 px-2.5 text-sm text-muted-foreground">
            {list.kind === "failed" ? (
              "OmO's commands could not be read."
            ) : list.kind === "ready" ? (
              `No OmO command matches ${typed}.`
            ) : (
              <>
                <DelayedSpinner />
                Reading OmO's commands…
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
