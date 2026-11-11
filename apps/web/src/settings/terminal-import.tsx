import { Badge, Button, Dialog } from "@doriface/ui";
import { useState } from "react";
import { terminalConfigStore } from "../ghostty/config-store.ts";
import { mergeConfig, parseGhosttyConfig, type LineStatus, type ParsedConfig } from "../ghostty/parse.ts";
import { download } from "./download.ts";
import { serializeGhosttyConfig } from "../ghostty/serialize.ts";

const STATUS: Readonly<
  Record<LineStatus, { readonly label: string; readonly tone: "done" | "neutral" | "working" | "blocked" }>
> = {
  applies: { label: "Applies", tone: "done" },
  "new-terminals": { label: "New terminals", tone: "done" },
  unsupported: { label: "Not applied", tone: "neutral" },
  invalid: { label: "Invalid", tone: "blocked" },
  unknown: { label: "Unknown", tone: "working" },
};

function count(parsed: ParsedConfig, ...statuses: readonly LineStatus[]): number {
  return parsed.lines.filter((line) => statuses.includes(line.status)).length;
}

export function ImportPreview({ parsed, onClose }: { readonly parsed: ParsedConfig; readonly onClose: () => void }) {
  const applied = count(parsed, "applies", "new-terminals");
  const skipped = count(parsed, "invalid", "unknown");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Import this Ghostty config?"
      description={`${applied} ${applied === 1 ? "key applies" : "keys apply"}, ${count(parsed, "unsupported")} kept but not applied, ${skipped} skipped.`}
      className="w-[min(36rem,calc(100%-2rem))]"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={parsed.config.size === 0}
            onClick={() => {
              void terminalConfigStore.update((current) => mergeConfig(current, parsed.config));
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
            <span title={`${line.key} = ${line.value}`} className="min-w-0 flex-1 truncate text-foreground">
              {line.key} = {line.value}
            </span>
            <Badge tone={STATUS[line.status].tone}>{STATUS[line.status].label}</Badge>
            {line.reason === undefined ? null : (
              <span className="basis-full pl-9 font-sans text-prose text-muted-foreground">{line.reason}</span>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Choose a Ghostty config file to preview, or download the current settings as one. */
export function ImportExport({ readOnly }: { readonly readOnly: boolean }) {
  const [parsed, setParsed] = useState<ParsedConfig | null>(null);
  const pick = (): void => {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file !== undefined) void file.text().then((text) => setParsed(parseGhosttyConfig(text)));
    });
    input.click();
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={readOnly} onClick={pick}>
        Import Ghostty config…
      </Button>
      <Button
        size="sm"
        onClick={() =>
          void terminalConfigStore.loaded.then(() =>
            download("ghostty-config", serializeGhosttyConfig(terminalConfigStore.config)),
          )
        }
      >
        Export
      </Button>
      {parsed === null ? null : <ImportPreview parsed={parsed} onClose={() => setParsed(null)} />}
    </div>
  );
}
