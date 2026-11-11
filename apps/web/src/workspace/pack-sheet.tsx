import { Badge, Button, Sheet } from "@doriface/ui";
import { useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { packEntries, packName } from "../keybar/entries.ts";
import { FAVORITES_PACK_ID } from "../keybar/packs.ts";
import { setActivePack } from "../keybar/operations.ts";
import type { KeyBarSettings } from "../keybar/settings.ts";
import { keyBarStore } from "../keybar/store.ts";

export interface PackSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly settings: KeyBarSettings;
}

/**
 * The packs panel: every pack the person turned on, as tabs of the bar. Picking one puts its keys ahead of their own in
 * the row, and the choice stays on this device. Long-press Ctrl opens this panel; the bar's key held down opens it too.
 */
export function PackSheet({ open, onOpenChange, settings }: PackSheetProps) {
  const navigate = useNavigate();
  const choose = (id: string | null): void => {
    void keyBarStore.update((current) => setActivePack(current, id));
    onOpenChange(false);
  };
  return (
    <Sheet title="Shortcut packs" side="bottom" open={open} onOpenChange={onOpenChange}>
      <p className="pb-2 text-prose text-muted-foreground">
        A pack's keys lead the bar; your own follow them. Long-press Ctrl opens this panel.
      </p>
      {settings.packs.length === 0 ? (
        <p className="pb-2 text-prose text-muted-foreground">No packs yet. Add one in Settings &gt; Keyboard.</p>
      ) : (
        <div role="list" className="flex flex-col">
          <button
            type="button"
            role="listitem"
            aria-pressed={settings.activePack === null}
            onClick={() => choose(null)}
            className="flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground active:bg-selected"
          >
            <span className="min-w-0 flex-1">No pack</span>
            {settings.activePack === null ? <Check aria-hidden className="size-4" /> : null}
          </button>
          {settings.packs.map((id) => {
            const count = id === FAVORITES_PACK_ID ? settings.favorites.length : packEntries(settings, id).length;
            const active = settings.activePack === id;
            return (
              <button
                key={id}
                type="button"
                role="listitem"
                aria-pressed={active}
                onClick={() => choose(id)}
                className="flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground active:bg-selected"
              >
                <span className="min-w-0 flex-1">
                  {packName(id)}
                  <span className="block text-xs text-muted-foreground">
                    {count} {count === 1 ? "key" : "keys"}
                  </span>
                </span>
                {active ? <Badge>In the bar</Badge> : null}
                {active ? <Check aria-hidden className="size-4" /> : null}
              </button>
            );
          })}
        </div>
      )}
      <Button
        variant="secondary"
        className="mt-3 w-full"
        onClick={() => {
          onOpenChange(false);
          void navigate({ to: "/settings", hash: "keyboard" });
        }}
      >
        Edit keys and packs
      </Button>
    </Sheet>
  );
}
