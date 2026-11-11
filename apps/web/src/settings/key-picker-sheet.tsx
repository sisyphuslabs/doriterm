import { Button, Sheet, groupHeadingClass } from "@doriface/ui";
import { addPack, removePack, removeKey, restoreKey } from "../keybar/operations.ts";
import { packName } from "../keybar/entries.ts";
import { FAVORITES_PACK_ID, PACKS } from "../keybar/packs.ts";
import type { KeyBarSettings } from "../keybar/settings.ts";
import { keyBarStore } from "../keybar/store.ts";
import type { HostPlatform } from "../terminal/keys.ts";
import { GROUP_TITLE, groupedKeys } from "./key-groups.ts";

export interface KeyPickerSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly settings: KeyBarSettings;
  readonly host: HostPlatform;
  readonly readOnly: boolean;
}

const PACK_IDS = [...PACKS.map((entry) => entry.id), FAVORITES_PACK_ID];

const set = (change: (current: KeyBarSettings) => KeyBarSettings): void => {
  void keyBarStore.update(change);
};

/** The add-keys sheet: chips grouped modifiers, navigation, symbols and packs, each chip toggling membership. */
export function KeyPickerSheet({ open, onOpenChange, settings, host, readOnly }: KeyPickerSheetProps) {
  const hasKey = (id: string): boolean => settings.keys.includes(id);
  return (
    <Sheet title="Add keys" side="bottom" open={open} onOpenChange={onOpenChange}>
      <div className="flex flex-col gap-5">
        {groupedKeys(host).map(({ group, keys }) => (
          <section key={group} aria-label={GROUP_TITLE[group]} className="flex flex-col gap-2">
            <h3 className={groupHeadingClass}>{GROUP_TITLE[group]}</h3>
            <div className="flex flex-wrap gap-1.5">
              {keys.map((entry) => {
                const on = hasKey(entry.id);
                return (
                  <Button
                    key={entry.id}
                    size="sm"
                    aria-pressed={on}
                    aria-label={entry.name}
                    disabled={readOnly}
                    className="h-9 rounded-full px-3 text-base"
                    variant={on ? "primary" : "secondary"}
                    onClick={() =>
                      set((current) => (on ? removeKey(current, entry.id) : restoreKey(current, entry.id)))
                    }
                  >
                    {entry.label}
                  </Button>
                );
              })}
            </div>
          </section>
        ))}
        <section aria-label="Packs" className="flex flex-col gap-2">
          <h3 className={groupHeadingClass}>Packs</h3>
          <div className="flex flex-wrap gap-1.5">
            {PACK_IDS.map((id) => {
              const on = settings.packs.includes(id);
              return (
                <Button
                  key={id}
                  size="sm"
                  aria-pressed={on}
                  disabled={readOnly}
                  className="h-9 rounded-full px-3 text-base"
                  variant={on ? "primary" : "secondary"}
                  onClick={() => set((current) => (on ? removePack(current, id) : addPack(current, id)))}
                >
                  {packName(id)}
                </Button>
              );
            })}
          </div>
        </section>
      </div>
    </Sheet>
  );
}
