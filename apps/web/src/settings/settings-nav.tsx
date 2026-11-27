import { Button, ScrollArea, cn } from "@doriface/ui";
import { useId, type ReactNode } from "react";
import { captionClass } from "./settings-layout.tsx";
import { groupSections, type SectionId, type SettingsSection } from "./settings-sections.tsx";

/** The title row's own heading: one size per pointer from `--settings-title`, on every surface Settings has. */
export function SettingsTitle({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <h1
      className={cn(
        "truncate text-(length:--settings-title) leading-tight font-(weight:--settings-title-weight) text-foreground",
        className,
      )}
    >
      {children}
    </h1>
  );
}

function NavGroup({
  group,
  entries,
  section,
  onSection,
}: {
  readonly group: string;
  readonly entries: readonly SettingsSection[];
  readonly section: SectionId;
  readonly onSection: (id: SectionId) => void;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-px pt-3 first:pt-0">
      <div id={id} className={cn(captionClass, "px-2.5")}>
        {group}
      </div>
      {entries.map((entry) => (
        <Button
          key={entry.id}
          variant="ghost"
          aria-current={entry.id === section ? "page" : undefined}
          onClick={() => onSection(entry.id)}
          className={cn(
            "h-auto min-h-(--hit) shrink-0 justify-start gap-2.5 rounded-(--settings-nav-radius) px-2.5 py-(--settings-nav-item-y) text-(length:--settings-nav-item) font-normal",
            entry.id === section ? "bg-selected text-foreground" : "text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "flex size-(--settings-tile) shrink-0 items-center justify-center rounded-(--settings-tile-radius) [&_svg:not([data-slot=spinner])]:size-(--settings-icon)",
              entry.tile,
              "coarse:text-(--avatar-ink)",
            )}
          >
            {entry.icon}
          </span>
          {entry.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * The navigation beside the form on a wide screen (iPad and up): the title row with Close, the one search, then the
 * sections under their group captions. The sections scroll on their own, so a short window never takes the title row,
 * which drags the window (#1915).
 */
export function SettingsNav({
  titlebar,
  dialog,
  back,
  search,
  nothing,
  shown,
  section,
  onSection,
}: {
  readonly titlebar: Readonly<Record<string, string>>;
  /** In the dialog the title row is not the window's titlebar: it makes no room for the window's buttons. */
  readonly dialog: boolean;
  readonly back: ReactNode;
  readonly search: ReactNode;
  readonly nothing: ReactNode;
  readonly shown: readonly SettingsSection[];
  readonly section: SectionId;
  readonly onSection: (id: SectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings"
      className={cn(
        "hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2.5 pb-2 md:flex",
        dialog
          ? "w-(--settings-nav-width)"
          : "w-[max(var(--settings-nav-width),calc(var(--titlebar-inset-start,0px)+8.5rem))]",
      )}
    >
      <div
        {...titlebar}
        className={cn(
          "mb-1 flex h-11 shrink-0 items-center gap-1",
          !dialog && "pl-[calc(var(--titlebar-inset-start,0.5rem)-0.5rem)]",
        )}
      >
        {back}
        <SettingsTitle>Settings</SettingsTitle>
      </div>
      <div className="shrink-0 pb-2">{search}</div>
      {/* The viewport's padding, taken back by the margins, is room for each button's focus ring, which the scroller
          would otherwise cut; scroll-padding keeps that room when the keyboard scrolls a button into view. */}
      <ScrollArea slot="settings-sections" className="-mx-2.5 -mb-1 flex-1" viewportClassName="scroll-py-1 px-2.5 py-1">
        <div className="flex flex-col">
          {nothing}
          {groupSections(shown).map(({ group, entries }) => (
            <NavGroup key={group} group={group} entries={entries} section={section} onSection={onSection} />
          ))}
        </div>
      </ScrollArea>
    </nav>
  );
}
