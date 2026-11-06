import {
  AA_GRAPHIC,
  ansiTextContrast,
  Button,
  IconButton,
  Notice,
  SegmentedControl,
  SettingRow,
  ThemeBrowser,
  type ThemeOption,
} from "@doriface/ui";
import { Minus, Plus } from "lucide-react";
import { useRef, useState } from "react";
import {
  appearanceStore,
  themeChoices,
  useAppearance,
  type AppearanceMode,
  type Density,
} from "../appearance/appearance.ts";
import { useTerminalConfig } from "../ghostty/config-store.ts";
import { isDefault, single } from "../ghostty/config.ts";
import { useActionKeys } from "../keys/use-action-keys.ts";
import { useDarkScheme } from "../terminal/use-dark-scheme.ts";
import { stepTerminalFont } from "../workspace/use-app-actions.ts";
import { importThemeFile } from "./import-theme.ts";

const MODES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: AppearanceMode; label: string }[];

const DENSITIES = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
  { value: "spacious", label: "Spacious" },
] as const satisfies readonly { value: Density; label: string }[];

/**
 * The terminals' text size beside the other display choices, stepped as the zoom keys step it; Settings > Terminal has
 * the same font-size among its other keys.
 */
function TextSizeRow() {
  const config = useTerminalConfig();
  const smaller = useActionKeys("app.zoom_out");
  const larger = useActionKeys("app.zoom_in");
  return (
    <SettingRow
      title="Text size"
      description="The terminals' font size, in points."
      control={
        <div className="flex items-center gap-1">
          <IconButton
            label="Smaller terminal text"
            {...(smaller === undefined ? {} : { keys: smaller })}
            icon={<Minus />}
            onClick={() => stepTerminalFont("app.zoom_out")}
          />
          <output data-numeric className="min-w-14 text-center text-sm text-foreground tabular-nums">
            {single(config, "font-size")} pt
          </output>
          <IconButton
            label="Larger terminal text"
            {...(larger === undefined ? {} : { keys: larger })}
            icon={<Plus />}
            onClick={() => stepTerminalFont("app.zoom_in")}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={isDefault(config, "font-size")}
            onClick={() => stepTerminalFont("app.zoom_reset")}
          >
            Reset
          </Button>
        </div>
      }
    />
  );
}

/** Light/dark mode, a dark and a light pick from the theme library, density, text size, and herdr-app theme import. */
export function AppearanceSection() {
  const appearance = useAppearance();
  const systemDark = useDarkScheme();
  const picker = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const options: ThemeOption[] = [...themeChoices(appearance.custom)].map(([id, { name, source, theme }]) => ({
    id,
    name,
    source,
    theme,
  }));
  /** Picks whose ANSI text colours fall under 3:1 on their own background, as their project ships them. */
  const faint = options
    .filter((option) => [appearance.dark, appearance.light].includes(option.id))
    .filter((option) => ansiTextContrast(option.theme) < AA_GRAPHIC)
    .map((option) => option.name);
  const shownKind = appearance.mode === "system" ? (systemDark ? "dark" : "light") : appearance.mode;

  return (
    <div className="flex flex-col">
      <SettingRow
        title="Appearance"
        description="System follows this device's light or dark setting."
        control={
          <SegmentedControl
            label="Appearance"
            value={appearance.mode}
            options={MODES}
            onValueChange={(mode) => appearanceStore.update({ mode })}
          />
        }
      />
      <ThemeBrowser
        options={options}
        dark={appearance.dark}
        light={appearance.light}
        defaultKind={shownKind}
        onPick={(id, kind) =>
          appearanceStore.update({ [kind]: id, mode: appearance.mode === "system" ? "system" : kind })
        }
        className={faint.length === 0 ? "border-b border-border" : ""}
      />
      {faint.length === 0 ? null : (
        <p role="note" className="border-b border-border pb-3 text-sm text-pretty text-muted-foreground">
          {faint.join(" and ")} {faint.length === 1 ? "ships" : "ship"} some terminal colours below 3:1 on
          {faint.length === 1 ? " its" : " their"} background. Settings &gt; Terminal &gt; palette overrides any of them
          (3=#rrggbb); minimum-contrast, which would lift them all, is not available in the web terminal yet.
        </p>
      )}
      <SettingRow
        title="Density"
        description="Row height in the sidebar, lists and menus. The terminals' text has its own size, below."
        control={
          <SegmentedControl
            label="Density"
            value={appearance.density}
            options={DENSITIES}
            onValueChange={(density) => appearanceStore.update({ density })}
          />
        }
      />
      <TextSizeRow />
      <SettingRow
        title="Import a herdr-app theme"
        description="A herdr-app theme file (.json) imports unchanged."
        control={
          <>
            <input
              ref={picker}
              type="file"
              accept="application/json,.json"
              aria-label="Theme file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file === undefined) return;
                importThemeFile(file, appearance).then(
                  () => setImportError(null),
                  (cause: unknown) => setImportError(cause instanceof Error ? cause.message : String(cause)),
                );
              }}
            />
            <Button size="sm" onClick={() => picker.current?.click()}>
              Choose file…
            </Button>
          </>
        }
      />
      {importError === null ? null : (
        <Notice tone="error" title="That theme cannot be used">
          {importError}
        </Notice>
      )}
    </div>
  );
}
