import { Input, cn } from "@doriface/ui";
import { ChevronRight, Search } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";

/**
 * Settings' one scale (#2878) and one shape (#2914): every section heads, groups, spaces and lines up its rows through
 * these, and every size is a `--settings-*` token (tokens.css) with a fine-pointer and a coarse-pointer value. Fine
 * follows the Herdr desktop app (flat rows under small uppercase captions); coarse follows its phone app (sentence-case
 * captions over inset cards, rows of one height, a trailing value the size of the title).
 */

/** The blocks of one section (a notice, a preview, a toolbar, the sub-groups), a group's gap apart. */
export const sectionStackClass = "flex flex-col gap-(--settings-group-gap)";

/** A group's caption: over its card, inset to the rows' text. */
export const captionClass =
  "px-(--settings-caption-inset) pb-2 text-(length:--settings-caption) leading-4 font-(weight:--settings-caption-weight) [text-transform:var(--settings-caption-case)] text-muted-foreground";

/**
 * A group's rows on their card. A card holding another card draws none itself, so the rows sit on the innermost card
 * whichever level a section groups them at. The card pads only its leading side; rows pad their trailing side by
 * `--settings-row-reach`, so a row's divider reaches the card's edge, and anything else on it that holds no rows keeps
 * that much margin from the edge, so a bordered control or a notice stays inside too.
 */
export const cardClass =
  "flex flex-col rounded-(--settings-card-radius) bg-(--settings-card-bg) pl-(--settings-card-inset) [--settings-row-reach:var(--settings-card-inset)] has-[[data-settings-card]]:rounded-none has-[[data-settings-card]]:bg-transparent has-[[data-settings-card]]:pl-0 has-[[data-settings-card]]:[--settings-row-reach:0px] [&>*:not([data-setting-row]):not([data-list-row]):not(:has([data-setting-row],[data-list-row]))]:mr-[var(--settings-row-reach,0px)] [&>*:has([data-setting-row],[data-list-row])>*:not([data-setting-row]):not([data-list-row]):not(:has([data-setting-row],[data-list-row]))]:mr-[var(--settings-row-reach,0px)]";

/**
 * A list row that is not a SettingRow (a link into a sheet, a key, a pack): SettingRow's height, padding and divider.
 * On a card it pads its own trailing side (`--settings-row-reach`, which only a card sets) while the card pads only its
 * leading one, so its divider starts at the text and runs to the card's edge without leaving its box; in a sheet it has
 * no such padding.
 */
export const listRowClass =
  "flex min-h-(--settings-row-min) items-center gap-3 border-b border-border py-(--settings-row-y) pr-[var(--settings-row-reach,0px)] last:border-b-0";

/** A row's trailing value: the size of its title, quieter by colour. */
export const rowValueClass = "text-(length:--settings-row-title) leading-[1.375rem] text-muted-foreground";

/** A row's second line under its title. */
export const rowDetailClass = "text-(length:--settings-row-detail) leading-5 text-muted-foreground";

/** A group's rows on a card; `data-settings-card` lets an outer card stand down. */
export function SettingsCard({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div data-settings-card="" className={cn(cardClass, className)}>
      {children}
    </div>
  );
}

/** A group's caption with the section's own actions (Edit, Done) on the same line. */
export function SectionHeader({
  title,
  id,
  actions,
}: {
  readonly title: string;
  readonly id?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-6 items-end justify-between gap-3">
      <h2 id={id} className={captionClass}>
        {title}
      </h2>
      {actions}
    </div>
  );
}

/** A titled run of rows inside a section (Font, Notify me when, In the bar): its caption over its own card. */
export function Subgroup({
  title,
  id,
  label,
  className,
  children,
  ...data
}: {
  readonly title: ReactNode;
  readonly id?: string;
  /** Names the group for assistive tech when it has no id to be labelled by. */
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly [data: `data-${string}`]: string | undefined;
}) {
  return (
    <section
      {...data}
      {...(id === undefined ? {} : { "aria-labelledby": id })}
      {...(label === undefined ? {} : { "aria-label": label })}
      className="flex flex-col"
    >
      <h3 id={id} className={cn(captionClass, className)}>
        {title}
      </h3>
      <SettingsCard>{children}</SettingsCard>
    </section>
  );
}

/**
 * A row that opens something (a section, a sheet): an optional icon on its tile, the title, a trailing value at the
 * title's size, and a chevron. `current` marks the section on show where the row is part of a navigation.
 */
export function LinkRow({
  title,
  value,
  icon,
  tile,
  current = false,
  onClick,
}: {
  readonly title: string;
  readonly value?: string;
  readonly icon?: ReactNode;
  /** The tile's colour class (a `coarse:` one, SECTIONS' `tile`); without one the icon draws bare. */
  readonly tile?: string;
  readonly current?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-list-row
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={cn(
        listRowClass,
        "w-full text-left outline-none active:bg-selected focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring",
      )}
    >
      {icon === undefined ? null : (
        <span
          aria-hidden
          className={cn(
            "flex size-(--settings-tile) shrink-0 items-center justify-center rounded-(--settings-tile-radius) [&_svg:not([data-slot=spinner])]:size-(--settings-icon)",
            "text-muted-foreground",
            tile !== undefined && cn(tile, "coarse:text-(--avatar-ink)"),
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-(length:--settings-row-title) leading-[1.375rem] text-foreground">
        {title}
      </span>
      {value === undefined ? null : (
        <span data-row-value className={cn("shrink-0", rowValueClass)}>
          {value}
        </span>
      )}
      <ChevronRight aria-hidden className="size-(--settings-chevron) shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * One search field drawn as a single row: its label ("Search") sits inside the field's box at the field's own size, so
 * it stays readable while typing (#1497) without a caption of its own over or beside it (#2914).
 */
export function SearchRow({
  name,
  placeholder,
  value,
  onValueChange,
  className,
  ...field
}: {
  /** What is searched, read after "Search" by assistive tech: "settings", "terminal settings", "keybindings". */
  readonly name: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  readonly className?: string;
} & Omit<ComponentProps<typeof Input>, "id" | "type" | "value" | "onValueChange" | "placeholder" | "className">) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex h-(--control) min-w-0 items-center gap-1.5 rounded-lg bg-surface pl-2.5 inset-ring inset-ring-input hover:inset-ring-ring/60 focus-within:inset-ring-ring focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-solid focus-within:outline-ring/40",
        className,
      )}
    >
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <label
        htmlFor={id}
        className="shrink-0 text-(length:--settings-row-title) leading-[1.375rem] text-muted-foreground"
      >
        Search<span className="sr-only"> {name}</span>
      </label>
      <Input
        {...field}
        id={id}
        type="search"
        className="h-full min-w-0 flex-1 border-0 bg-transparent pl-1 focus-visible:outline-none"
        placeholder={placeholder}
        value={value}
        onValueChange={onValueChange}
      />
    </div>
  );
}

/**
 * A section's search with its actions, drawn in the order focus moves through them: search, reset, then the actions.
 * Wide, that is one line. Narrow, reset ends the search line and the actions take the next, so nothing is left alone on
 * a line of its own, down to 320 px.
 */
export function SettingsToolbar({
  name,
  placeholder,
  query,
  onQuery,
  actions,
  reset,
}: {
  /** What is searched, read after "Search" by assistive tech: "terminal settings", "keybindings". */
  readonly name: string;
  readonly placeholder: string;
  readonly query: string;
  readonly onQuery: (next: string) => void;
  readonly actions: ReactNode;
  readonly reset: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
      <SearchRow
        name={name}
        placeholder={placeholder}
        value={query}
        onValueChange={onQuery}
        className="h-(--control-sm) sm:min-w-48 sm:flex-1"
      />
      <div>{reset}</div>
      <div className="col-span-2 flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
