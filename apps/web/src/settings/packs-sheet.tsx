import { Sheet, Switch } from "@doriface/ui";
import { packEntries, packName } from "../keybar/entries.ts";
import { addPack, removePack } from "../keybar/operations.ts";
import { FAVORITES_PACK_ID, PACKS } from "../keybar/packs.ts";
import type { KeyBarSettings } from "../keybar/settings.ts";
import { keyBarStore } from "../keybar/store.ts";

export interface PacksSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly settings: KeyBarSettings;
  readonly readOnly: boolean;
}

const ROWS = [
  ...PACKS.map((entry) => ({ id: entry.id, name: entry.name, description: entry.description })),
  { id: FAVORITES_PACK_ID, name: packName(FAVORITES_PACK_ID), description: "The keys you defined yourself" },
];

/** The packs as toggles: a name, one line about what it puts in the bar, its count, and the switch. Nothing else. */
export function PacksSheet({ open, onOpenChange, settings, readOnly }: PacksSheetProps) {
  return (
    <Sheet title="Packs" side="bottom" open={open} onOpenChange={onOpenChange}>
      <ul className="flex flex-col">
        {ROWS.map((row) => {
          const on = settings.packs.includes(row.id);
          const count = row.id === FAVORITES_PACK_ID ? settings.favorites.length : packEntries(settings, row.id).length;
          return (
            <li
              key={row.id}
              data-pack-row={row.id}
              className="flex min-h-14 items-center gap-3 border-b border-border py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2 text-base text-foreground">
                  <span className="min-w-0 truncate">{row.name}</span>
                  {/* The count sits on the title line so the description can ellipsize without eating it. */}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {count} {count === 1 ? "key" : "keys"}
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground">{row.description}</p>
              </div>
              <Switch
                aria-label={`${on ? "Remove" : "Add"} ${row.name} pack`}
                checked={on}
                disabled={readOnly}
                onCheckedChange={(next: boolean) =>
                  void keyBarStore.update((current) => (next ? addPack(current, row.id) : removePack(current, row.id)))
                }
              />
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
