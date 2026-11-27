import { Button, cn } from "@doriface/ui";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { LinkRow, SettingsCard, captionClass, sectionStackClass } from "./settings-layout.tsx";
import { SettingsTitle } from "./settings-nav.tsx";
import { groupSections, type SectionId, type SettingsSection } from "./settings-sections.tsx";

/**
 * The phone's header, as the Herdr phone app draws it: Done at the top right (Back to the list on a section's page), the
 * page's large title alone on its line, and on the list the one search under it. On a phone the header takes the top
 * inset itself, so it is the page's top edge for iOS (styles.css, #2867).
 */
export function PhoneHeader({
  titlebar,
  dialog,
  title,
  onBack,
  onClose,
  search,
}: {
  readonly titlebar: Readonly<Record<string, string>>;
  readonly dialog: boolean;
  readonly title: string;
  /** Back to the list of sections; absent on the list itself. */
  readonly onBack?: () => void;
  readonly onClose: () => void;
  readonly search?: ReactNode;
}) {
  return (
    <div
      {...titlebar}
      {...(dialog ? {} : { "data-phone-top": "" })}
      className={cn(
        "flex flex-col gap-2 pr-4 pb-2 pl-[var(--titlebar-inset-start,1rem)] md:hidden",
        dialog ? "pt-2" : "bg-background pt-[calc(var(--safe-top)+0.5rem)]",
      )}
    >
      <div className="flex h-(--control) items-center justify-between gap-2">
        {onBack === undefined ? (
          <span />
        ) : (
          <Button variant="ghost" onClick={onBack} className="gap-0.5 pr-2 pl-0 font-normal text-foreground">
            <ChevronLeft aria-hidden />
            Settings
          </Button>
        )}
        <Button
          variant="secondary"
          aria-label="Done, close settings"
          aria-keyshortcuts="Escape"
          onClick={onClose}
          className="rounded-full px-4 font-semibold text-foreground"
        >
          Done
        </Button>
      </div>
      <SettingsTitle>{title}</SettingsTitle>
      {search}
    </div>
  );
}

/** The phone's first screen: every section under its group's caption, each a row that opens the section's page. */
export function PhoneSections({
  shown,
  onOpen,
}: {
  readonly shown: readonly SettingsSection[];
  readonly onOpen: (id: SectionId) => void;
}) {
  return (
    <div data-settings-list className={cn(sectionStackClass, "md:hidden")}>
      {groupSections(shown).map(({ group, entries }) => (
        <section key={group} className="flex flex-col">
          <h2 className={captionClass}>{group}</h2>
          <SettingsCard>
            {entries.map((entry) => (
              <LinkRow
                key={entry.id}
                title={entry.label}
                icon={entry.icon}
                tile={entry.tile}
                onClick={() => onOpen(entry.id)}
              />
            ))}
          </SettingsCard>
        </section>
      ))}
    </div>
  );
}
