import {
  Badge,
  Button,
  IconButton,
  Input,
  Notice,
  SettingRow,
  TerminalPreview,
  type TerminalLine,
  cn,
  fieldLabelClass,
} from "@doriface/ui";
import { asSentence } from "../storage/sentence.ts";
import { RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { EMPTY_CONFIG, effective, isDefault, withValues, withoutKey, type TerminalConfig } from "../ghostty/config.ts";
import { terminalConfigStore, useTerminalConfig, useTerminalConfigError } from "../ghostty/config-store.ts";
import { KEYS } from "../ghostty/keys.ts";
import { GROUP_LABEL, type Group, type KeyDef } from "../ghostty/schema.ts";
import { KeyControl } from "./terminal-control.tsx";
import { ImportExport } from "./terminal-import.tsx";

const GROUPS: readonly Group[] = ["font", "cursor", "colors", "spacing", "behavior"];

const PREVIEW: readonly TerminalLine[] = [
  [
    { text: "$ ", color: 2 },
    { text: "bun test", bold: true },
    { text: "  # fi ff ligatures", dim: true },
  ],
  [{ text: "✓ ", color: 2 }, { text: "parse.test.ts" }, { text: "  12 pass", dim: true }],
  [{ text: "✗ ", color: 1 }, { text: "trigger.test.ts" }, { text: "  1 fail", color: 3 }],
  [
    { text: "0 ", color: 0 },
    { text: "1 ", color: 1 },
    { text: "2 ", color: 2 },
    { text: "3 ", color: 3 },
    { text: "4 ", color: 4 },
    { text: "5 ", color: 5 },
    { text: "6 ", color: 6 },
    { text: "7 ", color: 7 },
    { text: "8 ", color: 8 },
    { text: "9 ", color: 9 },
    { text: "10 ", color: 10 },
    { text: "11 ", color: 11 },
    { text: "12 ", color: 12 },
    { text: "13 ", color: 13 },
    { text: "14 ", color: 14 },
    { text: "15", color: 15 },
  ],
  [{ text: "$ ", color: 2 }],
];

function matches(def: KeyDef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || def.key.includes(needle) || def.description.toLowerCase().includes(needle);
}

function KeyRow({
  def,
  config,
  readOnly,
}: {
  readonly def: KeyDef;
  readonly config: TerminalConfig;
  readonly readOnly: boolean;
}) {
  const [invalid, setInvalid] = useState<string | null>(null);
  const unsupported = def.support.level === "unsupported";
  const changed = !isDefault(config, def.key);
  return (
    <SettingRow
      id={`terminal-${def.key}`}
      className="items-start"
      title={
        <span className="flex flex-wrap items-center gap-2 font-mono text-sm">
          {def.key}
          {unsupported ? <Badge>Not applied</Badge> : null}
          {def.support.level === "new-terminals" ? <Badge>New terminals</Badge> : null}
        </span>
      }
      description={
        <>
          {def.description}
          {unsupported ? ` ${def.support.reason}` : null}
          {invalid === null ? null : <span className="block text-destructive">{invalid}</span>}
        </>
      }
      control={
        <>
          <KeyControl
            def={def}
            values={effective(config, def.key)}
            disabled={unsupported || readOnly}
            onCommit={(values) => {
              setInvalid(null);
              void terminalConfigStore.update((current) => withValues(current, def.key, values));
            }}
            onInvalid={setInvalid}
          />
          <IconButton
            label={`Reset ${def.key}`}
            disabled={readOnly}
            icon={<RotateCcw />}
            className={changed ? "" : "invisible"}
            onClick={() => void terminalConfigStore.update((current) => withoutKey(current, def.key))}
          />
        </>
      }
    />
  );
}

/** Every Ghostty key the renderer knows, grouped, searchable, with a live preview above. */
export function TerminalSection() {
  const config = useTerminalConfig();
  const storageError = useTerminalConfigError();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const shown = KEYS.filter((def) => matches(def, query));
  return (
    <div className="flex flex-col gap-5">
      {storageError === null ? null : (
        <Notice tone="error" title="Terminal settings could not be read from this browser's storage">
          Changes are not saved, so the stored terminal settings stay as they are. Reload the page to try again.{" "}
          {asSentence(storageError.message)}
        </Notice>
      )}
      <div className="wterm overflow-hidden rounded-lg border border-border" data-terminal-preview>
        <TerminalPreview
          label="Preview of the terminal with these settings"
          cursor
          lines={PREVIEW}
          className="font-(family-name:--term-font-family) text-(length:--term-font-pixels) leading-(--term-row-height)"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* The label beside the field, so the row keeps the field's height and the rows below do not move. */}
        <div className="flex w-full items-center gap-2 sm:w-72">
          <label htmlFor={searchId} className={cn("shrink-0", fieldLabelClass)}>
            Search<span className="sr-only"> terminal settings</span>
          </label>
          <Input
            id={searchId}
            type="search"
            className="min-w-0 flex-1"
            placeholder="Search keys, e.g. cursor"
            value={query}
            onValueChange={(next: string) => setQuery(next)}
          />
        </div>
        <ImportExport readOnly={storageError !== null} />
        <Button
          size="sm"
          variant="ghost"
          disabled={config.size === 0 || storageError !== null}
          onClick={() => void terminalConfigStore.update(() => EMPTY_CONFIG)}
        >
          Reset all
        </Button>
      </div>
      {GROUPS.map((group) => {
        const defs = shown.filter((def) => def.group === group);
        if (defs.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`terminal-group-${group}`} className="flex flex-col">
            <h3 id={`terminal-group-${group}`} className="pb-1 text-base font-semibold text-foreground">
              {GROUP_LABEL[group]}
            </h3>
            {defs.map((def) => (
              <KeyRow key={def.key} def={def} config={config} readOnly={storageError !== null} />
            ))}
          </section>
        );
      })}
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">No setting matches “{query}”.</p> : null}
    </div>
  );
}
