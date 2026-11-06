import { Badge, Button, Sheet, Switch } from "@doriface/ui";
import { ChevronDown, ChevronUp } from "lucide-react";
import { packEntries, packName } from "../keybar/entries.ts";
import { addPack, movePack, removePack, setActivePack } from "../keybar/operations.ts";
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

/** The packs as toggles, each with one line about what it puts in the bar, and Show for the one the bar leads with. */
export function PacksSheet({ open, onOpenChange, settings, readOnly }: PacksSheetProps) {
  return (
    <Sheet title="Packs" side="bottom" open={open} onOpenChange={onOpenChange}>
      <ul className="flex flex-col">
        {ROWS.map((row) => {
          const on = settings.packs.includes(row.id);
          const index = settings.packs.indexOf(row.id);
          const active = settings.activePack === row.id;
          const count = row.id === FAVORITES_PACK_ID ? settings.favorites.length : packEntries(settings, row.id).length;
          return (
            <li
              key={row.id}
              data-pack-row={row.id}
              className="flex items-center gap-2 border-b border-border py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-base text-foreground">
                  {row.name}
                  {active ? <Badge>In the bar</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.description} · {count} {count === 1 ? "key" : "keys"}
                </p>
              </div>
              {on ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${row.name} tab earlier`}
                    disabled={readOnly || index <= 0}
                    onClick={() => void keyBarStore.update((current) => movePack(current, row.id, index - 1))}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${row.name} tab later`}
                    disabled={readOnly || index === settings.packs.length - 1}
                    onClick={() => void keyBarStore.update((current) => movePack(current, row.id, index + 1))}
                  >
                    <ChevronDown />
                  </Button>
                  {active ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={readOnly}
                      onClick={() => void keyBarStore.update((current) => setActivePack(current, row.id))}
                    >
                      Show
                    </Button>
                  )}
                </>
              ) : null}
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
