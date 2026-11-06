import { IconButton, RowDropCaret, RowDropIndicator, rowPlacement, useListDrag } from "@doriface/ui";
import { GripVertical, Minus, Plus } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { specialKeysOn } from "../keybar/catalog.ts";
import { specialEntries } from "../keybar/entries.ts";
import { removeKey, restoreKey } from "../keybar/operations.ts";
import { inVisibleOrder } from "./key-order.ts";
import type { KeyBarSettings } from "../keybar/settings.ts";
import { keyBarStore } from "../keybar/store.ts";
import type { HostPlatform } from "../terminal/keys.ts";

export interface KeyboardEditProps {
  readonly settings: KeyBarSettings;
  readonly host: HostPlatform;
  readonly readOnly: boolean;
}

export function KeyboardEdit({ settings, host, readOnly }: KeyboardEditProps) {
  const list = useRef<HTMLUListElement | null>(null);
  const shown = specialEntries(settings, host);
  const ids = shown.map((entry) => entry.id);
  const { drag, settle, onPointerDown, onClickCapture } = useListDrag(list, ids, {
    onMove: readOnly ? undefined : (id, to) => reorder(id, to),
  });
  const removed = specialKeysOn(host).filter((entry) => !settings.keys.includes(entry.id));
  const [picked, setPicked] = useState<{ readonly id: string; readonly from: number } | null>(null);
  /** Set while the refocus after a move runs, so that focus landing back on the grip is not read as tabbing away. */
  const refocusing = useRef(false);
  const [said, setSaid] = useState("");
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const reorder = (id: string, to: number): void => {
    const ordered = shown.map((entry) => entry.id);
    const from = ordered.indexOf(id);
    if (from < 0 || to < 0 || to >= ordered.length || from === to) return;
    const next = [...ordered];
    next.splice(from, 1);
    next.splice(to, 0, id);
    void keyBarStore.update((current) => inVisibleOrder(current, next));
    // The row this grip belongs to moved in the DOM, which can drop focus: put it back so the next arrow key still lands
    // on the grip the person was holding, and Escape keeps cancelling the move instead of closing Settings.
    refocusing.current = true;
    requestAnimationFrame(() => {
      grips.current.get(id)?.focus();
      refocusing.current = false;
    });
  };
  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>, id: string, index: number, name: string): void => {
    if (event.key === "Escape") {
      if (picked === null) return;
      event.preventDefault();
      // Escape cancels: the key goes back where it was picked up from, which is what a list reorder means everywhere.
      reorder(id, picked.from);
      setPicked(null);
      setSaid(`${name} put back at position ${picked.from + 1} of ${shown.length}`);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (picked === null) {
        setPicked({ id, from: index });
        setSaid(`${name} picked up. Use the arrow keys to move it, Space to drop it.`);
      } else if (picked.id === id) {
        setPicked(null);
        setSaid(`${name} dropped at position ${index + 1} of ${shown.length}`);
      }
      return;
    }
    if (picked === null || picked.id !== id) return;
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (step === 0) return;
    const to = index + step;
    if (to < 0 || to >= shown.length) return;
    event.preventDefault();
    reorder(id, to);
    setSaid(`${name} moved to position ${to + 1} of ${shown.length}`);
  };
  return (
    <div className="flex flex-col gap-4">
      {/* While a key is picked up this list owns Escape, so the screen's own close shortcut cannot fire under the move. */}
      <section aria-label="In the bar" data-captures-keys={picked === null ? undefined : ""} className="flex flex-col">
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
                <button
                  type="button"
                  ref={(element) => {
                    if (element === null) grips.current.delete(entry.id);
                    else grips.current.set(entry.id, element);
                  }}
                  aria-label={`Reorder ${entry.name}`}
                  aria-pressed={picked?.id === entry.id}
                  disabled={readOnly}
                  onKeyDown={(event) => onGripKey(event, entry.id, index, entry.name)}
                  onBlur={() => {
                    if (refocusing.current) return;
                    if (picked?.id === entry.id) {
                      setPicked(null);
                      setSaid(`${entry.name} left where it is`);
                    }
                  }}
                  className={`flex size-11 items-center justify-center rounded-full outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring ${
                    picked?.id === entry.id ? "bg-selected text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <GripVertical className="size-4" aria-hidden />
                </button>
              </li>
            );
          })}
          {shown.length === 0 ? (
            <li className="px-3 py-3 text-sm text-muted-foreground">The bar has no keys. Add one below.</li>
          ) : null}
          {drag === null ? null : <RowDropIndicator drag={drag} />}
          {drag === null ? null : <RowDropCaret drag={drag} />}
        </ul>
        <p aria-live="polite" className="sr-only">
          {said}
        </p>
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
                className="size-6 rounded-full bg-affirmative text-affirmative-foreground hover:bg-affirmative/90"
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
