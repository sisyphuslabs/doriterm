import { IconButton, ScrollArea, cn } from "@doriface/ui";
import { ArrowLeft } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CrashProbe } from "../crash/crash-probe.ts";
import { RegionBoundary } from "../crash/region-boundary.tsx";
import { desktopBridge } from "../desktop/bridge.ts";
import { currentPlatform, triggerKeys } from "../keys/trigger.ts";
import { useActionHandler } from "../keys/dispatcher.ts";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { Group, SectionBody } from "../settings/settings-body.tsx";
import { useSettingsInDialog } from "../settings/settings-dialog.tsx";
import { SettingHits, useLandOn } from "../settings/settings-hits.tsx";
import { SearchRow, sectionStackClass } from "../settings/settings-layout.tsx";
import { SettingsNav } from "../settings/settings-nav.tsx";
import { PhoneHeader, PhoneSections } from "../settings/settings-phone.tsx";
import { matchSettings, type SettingHit } from "../settings/setting-rows.ts";
import { matchSections } from "../settings/settings-search.ts";
import { SECTIONS, sectionFromLink, type SectionId } from "../settings/settings-sections.tsx";
import { UpdateRow } from "../settings/update-row.tsx";
import { useCloseSettings } from "../settings/use-close-settings.ts";
import { usePendingUpdate } from "../update/update-store.ts";
import { stepTerminalFont } from "../workspace/use-app-actions.ts";

/** The width from which Settings draws its navigation beside the form (Tailwind's `md`). */
const WIDE = "(min-width: 48rem)";

/**
 * What a link asked for (a hash, so it survives a reload): its section, whether a phone opens on that section's page
 * (the link named one, or the screen is wide, where a section is always open, so a resize to a phone keeps it) rather
 * than the list, and the group to land on when an older link named one that is now part of a section, as Connect a
 * machine is part of Machines.
 */
function firstLanding(): { readonly section: SectionId; readonly paged: boolean; readonly landing: SettingHit | null } {
  const { section, group, named } = sectionFromLink(window.location.hash);
  const landing =
    group === undefined ? null : { section, title: "Connect a machine", detail: "", anchor: group, words: [] };
  return { section, paged: named || window.matchMedia(WIDE).matches, landing };
}

/**
 * Settings: on a phone a list of the sections under their group captions, each opening its own page; from `md` up the
 * same groups in a navigation beside the form. Changes apply as they are made.
 */
export function SettingsRoute() {
  // Settings shows the terminals' text size under Appearance and hints at its keys, so the text-size keys step it here
  // rather than the browser's zoom, in a browser too (#859, #1162).
  useActionHandler("app", (action) =>
    ["app.zoom_in", "app.zoom_out", "app.zoom_reset"].includes(action) ? stepTerminalFont(action) : false,
  );
  const [opened] = useState(firstLanding);
  const [section, setSection] = useState<SectionId>(opened.section);
  // Below `md` only: whether the phone shows the section's page (true) or the list of sections (false).
  const [paged, setPaged] = useState(opened.paged);
  const [query, setQuery] = useState("");
  const shown = matchSections(SECTIONS, query);
  const hits = matchSettings(query);
  const [landing, setLanding] = useState<SettingHit | null>(opened.landing);
  const body = useRef<HTMLDivElement>(null);
  useLandOn(
    landing,
    useCallback(() => body.current, []),
  );
  const field = useRef<HTMLInputElement>(null);
  const openSection = (id: SectionId) => {
    setSection(id);
    setPaged(true);
  };
  const open = (hit: SettingHit) => {
    setQuery("");
    openSection(hit.section);
    setLanding({ ...hit });
  };
  const onQuery = (next: string) => {
    setQuery(next);
    setLanding(null);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const [hit] = hits;
    const first = shown[0];
    if (event.key === "ArrowDown" && hit !== undefined) {
      event.preventDefault();
      body.current?.querySelector<HTMLElement>("[data-setting-hits] button")?.focus();
    } else if (event.key === "Enter" && hit !== undefined) open(hit);
    else if (event.key === "Enter" && first !== undefined) openSection(first.id);
  };
  const nothing =
    shown.length === 0 ? (
      <p className="px-(--settings-caption-inset) py-1 text-(length:--settings-row-detail) leading-5 text-muted-foreground">
        No setting matches "{query}"
      </p>
    ) : null;
  const search = (
    <SearchRow
      ref={field}
      name="settings"
      placeholder="e.g. theme"
      value={query}
      onValueChange={onQuery}
      onKeyDown={onSearchKey}
    />
  );
  const mesh = useBrowserMembership();
  const joinedBrowser = mesh.phase !== "empty" && desktopBridge() === null;
  const close = useCloseSettings();
  const update = usePendingUpdate();
  // In the dialog its header is not the window's titlebar: it neither moves the window nor makes room for its controls.
  const dialog = useSettingsInDialog();
  const titlebar = dialog ? {} : { "data-titlebar": "" };
  // The full-screen sheet takes focus as it opens, as the dialog does, unless something in it already has it (#1495).
  const view = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!dialog && !view.current?.contains(document.activeElement)) view.current?.focus({ preventScroll: true });
  }, [dialog]);
  const label = SECTIONS.find((entry) => entry.id === section)?.label ?? "Settings";
  return (
    <div
      ref={view}
      tabIndex={-1}
      className={cn(
        "flex h-full min-h-0 flex-col bg-background outline-none md:flex-row",
        !dialog && "pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left) md:pt-(--safe-top)",
      )}
    >
      <CrashProbe region="settings" />
      <PhoneHeader
        titlebar={titlebar}
        dialog={dialog}
        title={paged ? label : "Settings"}
        onClose={close}
        {...(paged ? { onBack: () => setPaged(false) } : { search })}
      />
      <SettingsNav
        titlebar={titlebar}
        dialog={dialog}
        back={
          <IconButton
            label="Close settings"
            keys={triggerKeys("escape", currentPlatform())}
            icon={<ArrowLeft />}
            onClick={close}
          />
        }
        search={search}
        nothing={nothing}
        shown={shown}
        section={section}
        onSection={openSection}
      />
      <ScrollArea slot="settings-body" className="flex-1">
        <div ref={body} className="flex max-w-2xl flex-col gap-(--settings-group-gap) px-4 pt-2 pb-6 md:px-7 md:py-5.5">
          {hits.length === 0 ? null : <SettingHits hits={hits} onOpen={open} onLeave={() => field.current?.focus()} />}
          {/* The Update row fails alone: a throw there must not take every section with it. It leads every page, the
              phone's list of sections included, so a pending update is seen as Settings opens. */}
          {update === null ? null : (
            <RegionBoundary
              region="settings-update"
              title="The update row could not be drawn"
              detail="The sections below still work."
            >
              <Group title="Update">
                <UpdateRow update={update} />
              </Group>
            </RegionBoundary>
          )}
          {paged ? null : (
            <div className={cn(sectionStackClass, "md:hidden")}>
              {nothing}
              <PhoneSections shown={shown} onOpen={openSection} />
            </div>
          )}
          <div className={cn(sectionStackClass, !paged && "max-md:hidden")}>
            <RegionBoundary
              key={section}
              region="settings-section"
              title="This section could not be drawn"
              detail="The other sections still open from the list."
            >
              <SectionBody section={section} joinedBrowser={joinedBrowser} />
            </RegionBoundary>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
