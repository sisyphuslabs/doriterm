import { Input, cn, fieldLabelClass, groupHeadingClass } from "@doriface/ui";
import { useId, type ReactNode } from "react";

/**
 * Settings' one scale (#2878): every section heads, groups, spaces and lines up its rows through these, so moving
 * between sections never changes the size of the screen. Sizes come from DESIGN.md's tokens only: headers `xl`, row
 * titles `base`, descriptions and values `prose`, sub-group headings `groupHeadingClass`, captions `xs`.
 */

/** The blocks of one section (a notice, a preview, a toolbar, the sub-groups), 16 px apart. */
export const sectionStackClass = "flex flex-col gap-4";

/** A list row that is not a SettingRow (a link into a sheet, a key, a pack): SettingRow's height, padding and divider. */
export const listRowClass = "flex min-h-12 items-center gap-3 border-b border-border py-2.5 last:border-b-0";

/** A trailing value or a row's second line: the reading size, quieter by colour, not by size. */
export const rowValueClass = "text-prose text-muted-foreground";

/** A section's or the search results' title, with the section's own actions (Edit, Done) on the same line. */
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
    <div className="flex items-center justify-between gap-3 pb-1">
      <h2 id={id} className="text-xl font-semibold text-foreground">
        {title}
      </h2>
      {actions}
    </div>
  );
}

/** A titled run of rows inside a section (Font, Notify me when, In the bar), its heading 4 px over the first row. */
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
      <h3 id={id} className={cn("pb-1", groupHeadingClass, className)}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * A section's search with its actions, every control the compact `--control-sm` height, drawn in the order focus
 * moves through them: search, reset, then the actions. Wide, that is one line. Narrow, reset ends the search line and
 * the actions take the next, so nothing is left alone on a line of its own, down to 320 px.
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
  const id = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
      <div className="flex min-w-0 items-center gap-2 sm:min-w-48 sm:flex-1">
        <label htmlFor={id} className={cn("shrink-0", fieldLabelClass)}>
          Search<span className="sr-only"> {name}</span>
        </label>
        <Input
          id={id}
          type="search"
          className="h-(--control-sm) min-w-0 flex-1"
          placeholder={placeholder}
          value={query}
          onValueChange={onQuery}
        />
      </div>
      <div>{reset}</div>
      <div className="col-span-2 flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
