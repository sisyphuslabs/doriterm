import { Button, Input, Notice, Sheet } from "@doriface/ui";
import { X } from "lucide-react";
import { useState } from "react";
import { MAX_TEXT_BYTES, parseKeyInput } from "../keybar/custom.ts";
import { addFavorite, removeFavorite } from "../keybar/operations.ts";
import type { KeyBarSettings } from "../keybar/settings.ts";
import { keyBarStore } from "../keybar/store.ts";

export interface CustomKeySheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly settings: KeyBarSettings;
  readonly readOnly: boolean;
}

/** A key's bytes as they read in a preview: text stays, every other byte becomes its hex escape. */
export function describeBytes(bytes: string): string {
  return [...bytes]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0x20) return "␣";
      if (code > 0x20 && code < 0x7f) return char;
      return `\\x${code.toString(16).padStart(2, "0")}`;
    })
    .join("");
}

/** The person's own keys: a label, what the key sends, and the bytes it will send before it is added. */
export function CustomKeySheet({ open, onOpenChange, settings, readOnly }: CustomKeySheetProps) {
  const [label, setLabel] = useState("");
  const [keys, setKeys] = useState("");
  const [error, setError] = useState<string | null>(null);
  const parsed = keys.trim() === "" ? null : parseKeyInput(keys);
  const preview =
    parsed === null
      ? null
      : parsed.kind === "ok"
        ? `sends: ${describeBytes(parsed.key.bytes)}`
        : `sends: ${parsed.reason}`;
  const add = (): void => {
    const name = label.trim();
    if (name === "") {
      setError("Give the key a label, e.g. Interrupt.");
      return;
    }
    if (parsed === null) {
      setError("Type what this key sends, e.g. Ctrl+C.");
      return;
    }
    if (parsed.kind === "error") {
      setError(parsed.reason);
      return;
    }
    const id = crypto.randomUUID();
    setError(null);
    setLabel("");
    setKeys("");
    void keyBarStore.update((current) => {
      const result = addFavorite(current, { id, label: name, input: keys });
      return result.kind === "added" ? result.settings : current;
    });
  };
  return (
    <Sheet title="Your keys" side="bottom" open={open} onOpenChange={onOpenChange}>
      <div className="flex flex-col gap-4">
        {settings.favorites.length === 0 ? (
          <p className="text-sm text-muted-foreground">No keys of your own yet.</p>
        ) : (
          <ul className="flex flex-col">
            {settings.favorites.map((entry) => (
              <li
                key={entry.id}
                data-custom-key={entry.id}
                className="flex min-h-12 items-center gap-2 border-b border-border last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base text-foreground">{entry.label}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {entry.input} · sends: {describeBytes(entry.bytes)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${entry.label}`}
                  disabled={readOnly}
                  onClick={() => void keyBarStore.update((current) => removeFavorite(current, entry.id))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <Input
            aria-label="Key label"
            placeholder="Label, e.g. Interrupt"
            value={label}
            disabled={readOnly}
            onValueChange={(next: string) => setLabel(next)}
          />
          <Input
            aria-label="Keys it sends"
            placeholder="Ctrl+X, Alt+Shift+A, F5, PgUp or text"
            value={keys}
            disabled={readOnly}
            className="font-mono"
            onValueChange={(next: string) => setKeys(next)}
          />
          <p aria-live="polite" className="min-h-4 font-mono text-xs text-muted-foreground">
            {preview ?? ""}
          </p>
          <p className="text-xs text-muted-foreground">
            A chord (Ctrl+X, Alt+Shift+A, Shift+Tab), a named key (F1 to F12, Home, End, PgUp, PgDn, Delete, Esc, Tab,
            Enter) or text up to {MAX_TEXT_BYTES} characters. Nothing here runs as code.
          </p>
          {error === null ? null : (
            <Notice tone="error" title="That key was not added">
              {error}
            </Notice>
          )}
          <Button size="sm" className="self-start" disabled={readOnly} onClick={add}>
            Add key
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
