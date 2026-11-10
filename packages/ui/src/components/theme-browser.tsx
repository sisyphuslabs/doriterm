import { Search } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import { cn } from "../lib/cn.ts";
import { fieldLabelClass, Input } from "./input.tsx";
import { SegmentedControl } from "./segmented-control.tsx";
import { ThemePicker, type ThemeOption } from "./theme-picker.tsx";

export type ThemeKind = "dark" | "light";

export interface ThemeBrowserProps {
  /** Every theme; each is listed under Dark or Light by its own `theme.light`. */
  readonly options: readonly ThemeOption[];
  /** The theme used when the appearance is dark, and when it is light. */
  readonly dark: string;
  readonly light: string;
  /** The list shown first. */
  readonly defaultKind: ThemeKind;
  readonly onPick: (id: string, kind: ThemeKind) => void;
  readonly className?: string;
}

const LABEL: Readonly<Record<ThemeKind, string>> = { dark: "Dark themes", light: "Light themes" };

const matches = (option: ThemeOption, query: string): boolean =>
  query === "" || `${option.name} ${option.source}`.toLowerCase().includes(query);

/**
 * The theme library: dark and light lists with their own pick, filtered by a search over name and source. A search
 * that matches nothing in this list says so in place, beside how many the other list holds.
 */
export function ThemeBrowser({ options, dark, light, defaultKind, onPick, className }: ThemeBrowserProps) {
  const [kind, setKind] = useState<ThemeKind>(defaultKind);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const query = useDeferredValue(search.trim().toLowerCase());
  const of = (wanted: ThemeKind) =>
    options.filter((option) => option.theme.light === (wanted === "light") && matches(option, query));
  const shown = of(kind);
  const other: ThemeKind = kind === "dark" ? "light" : "dark";
  const elsewhere = of(other).length;
  const pickName = (wanted: ThemeKind) =>
    options.find((option) => option.id === (wanted === "dark" ? dark : light))?.name ?? "None";
  return (
    <div className={cn("flex flex-col gap-3 py-3", className)}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[min(14rem,100%)] flex-1 flex-col gap-1">
          <label htmlFor={searchId} className={cn("px-0.5", fieldLabelClass)}>
            Search themes
          </label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              placeholder="Name or source, e.g. nord"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-8"
            />
          </div>
        </div>
        <SegmentedControl
          label="Theme list"
          value={kind}
          onValueChange={setKind}
          className="max-sm:w-full"
          options={[
            { value: "dark", label: `Dark ${of("dark").length}` },
            { value: "light", label: `Light ${of("light").length}` },
          ]}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Dark: <span className="text-foreground">{pickName("dark")}</span>
        <span aria-hidden> · </span>
        Light: <span className="text-foreground">{pickName("light")}</span>
      </p>
      {shown.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border border-border px-3 py-6 text-center text-sm text-muted-foreground"
        >
          No {kind} theme matches “{search.trim()}”.
          {elsewhere > 0 ? ` ${elsewhere} ${other} ${elsewhere === 1 ? "theme does" : "themes do"}.` : ""}
        </p>
      ) : (
        <ThemePicker
          label={LABEL[kind]}
          options={shown}
          value={kind === "dark" ? dark : light}
          onValueChange={(id) => onPick(id, kind)}
        />
      )}
    </div>
  );
}
