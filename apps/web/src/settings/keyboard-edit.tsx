import { IconButton, RowDropCaret, RowDropIndicator, rowPlacement, useListDrag } from "@doriface/ui";
import { GripVertical, Minus, Plus } from "lucide-react";
import { useRef } from "react";
import { specialKeysOn } from "../keybar/catalog.ts";
import { specialEntries } from "../keybar/entries.ts";
import { moveKey, removeKey, restoreKey } from "../keybar/operations.ts";
import type { KeyBarSettings } from "../keybar/settings.ts";
import { keyBarStore } from "../keybar/store.ts";
import type { HostPlatform } from "../terminal/keys.ts";

export interface KeyboardEditProps {
  readonly settings: KeyBarSettings;
  readonly host: HostPlatform;
  readonly readOnly: boolean;
}

const move = (id: string, to: number): void => {
  void keyBarStore.update((current) => moveKey(current, id, to));
};

/**
 * Edit mode, as an iOS list editor: the keys in the bar with a red minus and a grip to drag, and the keys left out with
 * a green plus. Nothing here exists while the page is not editing.
 */
export function KeyboardEdit({ settings, host, readOnly }: KeyboardEditProps) {
  const list = useRef<HTMLUListElement | null>(null);
  const shown = specialEntries(settings, host);
  const ids = shown.map((entry) => entry.id);
  const { drag, settle, onPointerDown, onClickCapture } = useListDrag(list, ids, {
    onMove: readOnly ? undefined : move,
  });
  const removed = specialKeysOn(host).filter((entry) => !settings.keys.includes(entry.id));
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="In the bar" className="flex flex-col">
        <h3 className="px-1 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">In the bar</h3>
        <ul ref={list} className="relative overflow-hidden rounded-lg border border-border bg-card">
          {shown.map((entry, index) => {
            const place = rowPlacement(entry.id, index, drag, settle);
            return (
              <li
                key={entry.id}
                data-drag-id={entry.id}
                data-edit-key={entry.id}
                style={place.offset === 0 ? undefined : { translate: `0 ${place.offset}px` }}
                onPointerDown={(event) => onPointerDown(event, entry.id, index)}
                onClickCapture={onClickCapture}
                className={`flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0 ${place.className}`}
              >
                <IconButton
                  data-drag-ignore
                  label={`Remove ${entry.name}`}
                  icon={<Minus />}
                  className="size-6 rounded-full bg-destructive text-background hover:bg-destructive/90"
                  disabled={readOnly}
                  onClick={() => void keyBarStore.update((current) => removeKey(current, entry.id))}
                />
                <span className="min-w-0 flex-1 truncate text-base text-foreground">{entry.label}</span>
                <span aria-hidden className="text-muted-foreground">
                  <GripVertical className="size-4" />
                </span>
              </li>
            );
          })}
          {shown.length === 0 ? (
            <li className="px-3 py-3 text-sm text-muted-foreground">The bar has no keys. Add one below.</li>
          ) : null}
          {drag === null ? null : <RowDropIndicator drag={drag} />}
          {drag === null ? null : <RowDropCaret drag={drag} />}
        </ul>
      </section>
      <section aria-label="More keys" className="flex flex-col">
        <h3 className="px-1 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">More keys</h3>
        <ul className="overflow-hidden rounded-lg border border-border bg-card">
          {removed.map((entry) => (
            <li
              key={entry.id}
              data-restore-key={entry.id}
              className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0"
            >
              <IconButton
                label={`Add ${entry.name}`}
                icon={<Plus />}
                className="size-6 rounded-full bg-brand text-brand-foreground hover:bg-brand/90"
                disabled={readOnly}
                onClick={() => void keyBarStore.update((current) => restoreKey(current, entry.id))}
              />
              <span className="min-w-0 flex-1 truncate text-base text-foreground">{entry.label}</span>
            </li>
          ))}
          {removed.length === 0 ? (
            <li className="px-3 py-3 text-sm text-muted-foreground">Every key is in the bar.</li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
