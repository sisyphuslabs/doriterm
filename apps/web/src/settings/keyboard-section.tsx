import { Button, Notice } from "@doriface/ui";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useConnection, useConnectionSettings } from "../connection/store.ts";
import { packName, specialEntries } from "../keybar/entries.ts";
import { useKeyBarError, useKeyBarSettings } from "../keybar/store.ts";
import { asSentence } from "../storage/sentence.ts";
import { useHostPlatform } from "../terminal/host-os.ts";
import { CustomKeySheet } from "./custom-key-sheet.tsx";
import { KeyBarHero } from "./key-bar-hero.tsx";
import { KeyboardEdit } from "./keyboard-edit.tsx";
import { KeyPickerSheet } from "./key-picker-sheet.tsx";
import { PacksSheet } from "./packs-sheet.tsx";
import { rememberedHostId } from "../terminal/known-host-os.ts";

type SheetId = "keys" | "packs" | "custom" | null;

/**
 * The platform the bar is drawn for: the connected host's, exactly as the terminal decides it, not this phone's. An
 * iPhone is not a Mac, so a preview keyed on the device would promise \`cmd\` to someone whose host has no Command key.
 */
function useBarHost() {
  const state = useConnection();
  const settings = useConnectionSettings();
  const live =
    state.phase === "open"
      ? state.connection
      : state.phase === "connecting" || state.phase === "failed"
        ? state.stale
        : null;
  // With a live line the core's own record answers, so ask for no machine in particular. Only when there is none does the
  // name guess run, and it takes the host's name, never its relay id: hostId is derived from a key, not a machine name.
  return useHostPlatform(
    live,
    live === null && settings.hostName !== "" ? settings.hostName : undefined,
    state.phase !== "open",
    rememberedHostId(settings),
  );
}

function LinkRow({
  title,
  value,
  onClick,
  last = false,
}: {
  readonly title: string;
  readonly value: string;
  readonly onClick: () => void;
  readonly last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-12 w-full items-center gap-3 px-4 text-left outline-none active:bg-selected focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring ${
        last ? "" : "border-b border-border"
      }`}
    >
      <span className="flex-1 text-base text-foreground">{title}</span>
      <span className="text-sm text-muted-foreground">{value}</span>
      <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
    </button>
  );
}

/**
 * Settings > Keyboard: the bar as the terminal draws it, three rows into the sheets that change it (keys, packs, the
 * person's own), and Edit for the only screen where keys can be removed or reordered.
 */
export function KeyboardSection() {
  const settings = useKeyBarSettings();
  const error = useKeyBarError();
  const host = useBarHost();
  const readOnly = error !== null;
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<SheetId>(null);
  const shown = specialEntries(settings, host).length;
  const packs = settings.packs.length;
  const own = settings.favorites.length;
  const packsValue =
    packs === 0 ? "None" : settings.activePack === null ? `${packs} on` : packName(settings.activePack);
  return (
    <section aria-label="Keyboard" className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Keyboard</h2>
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => setEditing(!editing)}>
          {editing ? "Done" : "Edit"}
        </Button>
      </header>
      {error === null ? null : (
        <Notice tone="error" title="Key settings could not be read from this browser's storage">
          Changes are not saved, so the stored keys stay as they are. Reload the page to try again.{" "}
          {asSentence(error.message)}
        </Notice>
      )}
      <KeyBarHero settings={settings} host={host} />
      {editing ? (
        <KeyboardEdit settings={settings} host={host} readOnly={readOnly} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <LinkRow title="Keys" value={`${shown} shown`} onClick={() => setSheet("keys")} />
          <LinkRow title="Packs" value={packsValue} onClick={() => setSheet("packs")} />
          <LinkRow title="Your keys" value={own === 0 ? "None" : `${own}`} onClick={() => setSheet("custom")} last />
        </div>
      )}
      <KeyPickerSheet
        open={sheet === "keys"}
        onOpenChange={(open) => setSheet(open ? "keys" : null)}
        settings={settings}
        host={host}
        readOnly={readOnly}
      />
      <PacksSheet
        open={sheet === "packs"}
        onOpenChange={(open) => setSheet(open ? "packs" : null)}
        settings={settings}
        readOnly={readOnly}
      />
      <CustomKeySheet
        open={sheet === "custom"}
        onOpenChange={(open) => setSheet(open ? "custom" : null)}
        settings={settings}
        readOnly={readOnly}
      />
    </section>
  );
}
