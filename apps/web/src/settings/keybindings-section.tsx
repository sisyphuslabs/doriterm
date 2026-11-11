import { Badge, Button, Dialog, Input, Notice, cn, fieldLabelClass, groupHeadingClass } from "@doriface/ui";
import { asSentence } from "../storage/sentence.ts";
import { useId, useMemo, useState } from "react";
import { ACTIONS, actionFor, SCOPE_LABEL, type ActionDef } from "../keys/actions.ts";
import { keymapStore, NewerKeymapError, useKeymapError, useOverrides } from "../keys/keymap-store.ts";
import {
  importKeybinds,
  isChanged,
  NO_OVERRIDES,
  parseKeybinds,
  resetAction,
  resolveKeymap,
  serializeKeybinds,
  withBinding,
  withoutTrigger,
  type ParsedKeybinds,
} from "../keys/keymap.ts";
import { currentPlatform } from "../keys/trigger.ts";
import { download } from "./download.ts";
import { KeybindingRow } from "./keybinding-row.tsx";

function ImportPreview({ parsed, onClose }: { readonly parsed: ParsedKeybinds; readonly onClose: () => void }) {
  const applied = parsed.lines.filter((line) => line.status === "applies").length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Import these keybindings?"
      description={`${applied} of ${parsed.lines.length} keybind lines apply; the rest are listed with the reason.`}
      className="w-[min(36rem,calc(100%-2rem))]"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={applied === 0}
            onClick={() => {
              void keymapStore.update((current) => importKeybinds(currentPlatform(), current, parsed));
              onClose();
            }}
          >
            Import
          </Button>
        </>
      }
    >
      <ul className="flex max-h-72 flex-col overflow-auto rounded-md border border-border font-mono text-sm">
        {parsed.lines.map((line) => (
          <li
            key={line.line}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-2.5 py-1.5 last:border-b-0"
          >
            <span className="w-6 shrink-0 text-right text-2xs text-muted-foreground tabular-nums">{line.line}</span>
            <span title={line.text} className="min-w-0 flex-1 truncate text-foreground">
              {line.text}
            </span>
            <Badge tone={line.status === "applies" ? "done" : line.status === "invalid" ? "blocked" : "working"}>
              {line.status === "applies" ? "Applies" : line.status === "invalid" ? "Invalid" : "Unknown"}
            </Badge>
            {line.reason === undefined ? null : (
              <span className="basis-full pl-9 font-sans text-prose text-muted-foreground">{line.reason}</span>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function matches(action: ActionDef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || action.label.toLowerCase().includes(needle) || action.id.includes(needle);
}

/** Every action with its shortcuts; record a new one, remove one, reset, and Ghostty keybind import/export. */
export function KeybindingsSection() {
  const platform = currentPlatform();
  const overrides = useOverrides();
  const storageError = useKeymapError();
  const keymap = useMemo(() => resolveKeymap(platform, overrides), [platform, overrides]);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const [parsed, setParsed] = useState<ParsedKeybinds | null>(null);
  const sends = [...new Set(keymap.values())].filter((id) => id.startsWith("send:")).map(actionFor);
  const actions = [...ACTIONS, ...sends.filter((action): action is ActionDef => action !== null)];
  const shown = actions.filter((action) => matches(action, query));
  const changed = (action: string): boolean => isChanged(platform, overrides, action);
  const pick = (): void => {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file !== undefined) void file.text().then((text) => setParsed(parseKeybinds(text)));
    });
    input.click();
  };
  return (
    <div className="flex flex-col gap-5">
      {storageError === null ? null : storageError instanceof NewerKeymapError ? (
        <Notice tone="warning" title="Keybindings were saved by a newer version of Doriterm">
          This version shows the default keys and saves no changes, so the newer version's keybindings stay as they are.
        </Notice>
      ) : (
        <Notice tone="error" title="Keybindings could not be read from this browser's storage">
          Changes are not saved, so the stored keybindings stay as they are. Reload the page to try again.{" "}
          {asSentence(storageError.message)}
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* The label beside the field, so the row keeps the field's height and the rows below do not move. */}
        <div className="flex w-full items-center gap-2 sm:w-72">
          <label htmlFor={searchId} className={cn("shrink-0", fieldLabelClass)}>
            Search<span className="sr-only"> keybindings</span>
          </label>
          <Input
            id={searchId}
            type="search"
            className="min-w-0 flex-1"
            placeholder="Search actions, e.g. tab"
            value={query}
            onValueChange={(next: string) => setQuery(next)}
          />
        </div>
        <Button size="sm" onClick={pick} disabled={storageError !== null}>
          Import keybinds…
        </Button>
        <Button size="sm" onClick={() => download("ghostty-keybinds", serializeKeybinds(overrides))}>
          Export
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={overrides.size === 0 || storageError !== null}
          onClick={() => void keymapStore.update(() => NO_OVERRIDES)}
        >
          Reset all
        </Button>
      </div>
      {(["app", "terminal"] as const).map((scope) => {
        const defs = shown.filter((action) => action.scope === scope);
        if (defs.length === 0) return null;
        return (
          <section key={scope} aria-labelledby={`keybindings-${scope}`} className="flex flex-col">
            <h3 id={`keybindings-${scope}`} className={cn("pb-1", groupHeadingClass)}>
              {SCOPE_LABEL[scope]}
            </h3>
            {defs.map((action) => (
              <KeybindingRow
                disabled={storageError !== null}
                key={action.id}
                action={action}
                keymap={keymap}
                platform={platform}
                changed={changed(action.id)}
                onBind={(trigger) =>
                  void keymapStore.update((current) => withBinding(platform, current, trigger, action.id))
                }
                onUnbind={(trigger) => void keymapStore.update((current) => withoutTrigger(platform, current, trigger))}
                onReset={() => void keymapStore.update((current) => resetAction(platform, current, action.id))}
              />
            ))}
          </section>
        );
      })}
      {shown.length === 0 ? <p className="text-prose text-muted-foreground">No action matches “{query}”.</p> : null}
      {parsed === null ? null : <ImportPreview parsed={parsed} onClose={() => setParsed(null)} />}
    </div>
  );
}
