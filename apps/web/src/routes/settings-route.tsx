import { Button, IconButton, Input, ScrollArea, Tab, TabList, Tabs, cn, fieldLabelClass } from "@doriface/ui";
import { ArrowLeft } from "lucide-react";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { currentPlatform, triggerKeys } from "../keys/trigger.ts";
import { useActionHandler } from "../keys/dispatcher.ts";
import { stepTerminalFont } from "../workspace/use-app-actions.ts";
import { AppearanceSection } from "../settings/appearance-section.tsx";
import { ConnectionSection } from "../settings/connection-section.tsx";
import { DeviceSection } from "../settings/device-section.tsx";
import { DevicesSection } from "../settings/devices-section.tsx";
import { KeybindingsSection } from "../settings/keybindings-section.tsx";
import { KeyboardSection } from "../settings/keyboard-section.tsx";
import { MeshSection } from "../settings/mesh-section.tsx";
import { MachinesSection } from "../settings/machines-section.tsx";
import { MembersSection } from "../settings/members-section.tsx";
import { NotificationsSection } from "../settings/notifications-section.tsx";
import { PairSection } from "../settings/pair-section.tsx";
import { TerminalSection } from "../settings/terminal-section.tsx";
import { UpdateRow } from "../settings/update-row.tsx";
import { CrashProbe } from "../crash/crash-probe.ts";
import { RegionBoundary } from "../crash/region-boundary.tsx";
import { usePendingUpdate } from "../update/update-store.ts";
import { useCloseSettings } from "../settings/use-close-settings.ts";
import { useSettingsInDialog } from "../settings/settings-dialog.tsx";
import { VoiceSection } from "../settings/voice-section.tsx";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { desktopBridge } from "../desktop/bridge.ts";
import { BrowserInvite } from "../settings/browser-invite.tsx";
import { CONNECT_GROUP, SECTIONS, sectionFromLink, type SectionId } from "../settings/settings-sections.tsx";
import { matchSections } from "../settings/settings-search.ts";
import { matchSettings, type SettingHit } from "../settings/setting-rows.ts";
import { SettingHits, useLandOn } from "../settings/settings-hits.tsx";

/**
 * What a link asked for (a hash, so it survives a reload): its section, and the group to land on when an older link named
 * one that is now part of a section, as Connect a machine is part of Machines.
 */
function firstLanding(): { readonly section: SectionId; readonly landing: SettingHit | null } {
  const { section, group } = sectionFromLink(window.location.hash);
  const landing =
    group === undefined ? null : { section, title: "Connect a machine", detail: "", anchor: group, words: [] };
  return { section, landing };
}

function Group({
  title,
  id,
  children,
}: {
  readonly title: string;
  readonly id?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <h2 id={id} className="pb-1 text-xl font-semibold text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One sentence under the title, in the words the navigation uses: what this screen is about and nothing else. */
function Lead({ children }: { readonly children: ReactNode }) {
  return <p className="max-w-measure text-prose text-pretty text-muted-foreground">{children}</p>;
}

/**
 * The one search over every section; drawn in the phone header and in the desktop navigation, each with its own id.
 * `inline` puts the label beside the field, so the phone's title row keeps its height (#1460).
 */
function SearchSettings({
  query,
  onQuery,
  onKeyDown,
  inputRef,
  inline = false,
}: {
  readonly query: string;
  readonly onQuery: (next: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly inline?: boolean;
}) {
  const id = useId();
  return (
    <div className={inline ? "flex items-center gap-2" : "flex flex-col gap-1"}>
      <label htmlFor={id} className={cn(inline ? "shrink-0" : "px-0.5", fieldLabelClass)}>
        {inline ? (
          <>
            Search<span className="sr-only"> settings</span>
          </>
        ) : (
          "Search settings"
        )}
      </label>
      <Input
        ref={inputRef}
        id={id}
        className={cn(inline && "min-w-0 flex-1")}
        type="search"
        // The phone's field shares the title row, so its hint is short enough to show whole there (#2575).
        placeholder={inline ? "theme, relay" : "e.g. theme or relay"}
        value={query}
        onValueChange={onQuery}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** Section navigation beside the form; changes apply as they are made. */
export function SettingsRoute() {
  // Settings shows the terminals' text size under Appearance and hints at its keys, so the text-size keys step it here
  // rather than the browser's zoom, in a browser too (#859, #1162).
  useActionHandler("app", (action) =>
    ["app.zoom_in", "app.zoom_out", "app.zoom_reset"].includes(action) ? stepTerminalFont(action) : false,
  );
  const [opened] = useState(firstLanding);
  const [section, setSection] = useState<SectionId>(opened.section);
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
  const open = (hit: SettingHit) => {
    setQuery("");
    setSection(hit.section);
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
    else if (event.key === "Enter" && first !== undefined) setSection(first.id);
  };
  const nothing =
    shown.length === 0 ? (
      <p className="px-2 py-1 text-prose text-muted-foreground">No setting matches "{query}"</p>
    ) : null;
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
  const back = (
    <IconButton
      label="Close settings"
      keys={triggerKeys("escape", currentPlatform())}
      icon={<ArrowLeft />}
      onClick={close}
    />
  );
  return (
    <div
      ref={view}
      tabIndex={-1}
      className={cn(
        "flex h-full min-h-0 flex-col bg-background outline-none md:flex-row",
        !dialog && "pt-(--safe-top) pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left)",
      )}
    >
      <CrashProbe region="settings" />
      <Tabs value={section} onValueChange={(value: SectionId) => setSection(value)} className="md:hidden">
        <div {...titlebar} className="flex items-center gap-1 pt-3 pr-2 pb-1 pl-[var(--titlebar-inset-start,0.5rem)]">
          {back}
          <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
          {/* In the title row, so the phone header keeps its height and the sections below do not move (#1460). */}
          <div className="ml-2 min-w-0 flex-1">
            <SearchSettings query={query} onQuery={onQuery} onKeyDown={onSearchKey} inputRef={field} inline />
          </div>
        </div>
        {nothing}
        <TabList className="scroll-px-2 px-2">
          {shown.map((entry) => (
            <Tab key={entry.id} value={entry.id}>
              {entry.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      <nav
        aria-label="Settings"
        className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2 pb-2 md:flex"
      >
        <div
          {...titlebar}
          className={cn(
            "mb-1 flex h-11 shrink-0 items-center gap-1",
            !dialog && "pl-[calc(var(--titlebar-inset-start,0.5rem)-0.5rem)]",
          )}
        >
          {back}
          <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
        </div>
        <div className="shrink-0">
          <SearchSettings query={query} onQuery={onQuery} onKeyDown={onSearchKey} inputRef={field} />
        </div>
        {/* The sections scroll on their own, so a short window never takes the title row, which drags the window (#1915).
            The viewport's padding, taken back by the margins, is room for each button's focus ring, which the scroller
            would otherwise cut; scroll-padding keeps that room when the keyboard scrolls a button into view. */}
        <ScrollArea slot="settings-sections" className="-mx-2 -mb-1 flex-1" viewportClassName="scroll-py-1 px-2 py-1">
          <div className="flex flex-col gap-px">
            {nothing}
            {shown.map((entry) => (
              <Button
                key={entry.id}
                variant="ghost"
                aria-current={entry.id === section ? "page" : undefined}
                onClick={() => setSection(entry.id)}
                className={cn(
                  "shrink-0 justify-start gap-2.5 px-2 text-sm [&_svg:not([data-slot=spinner])]:size-3.5",
                  entry.id === section && "bg-selected text-foreground",
                )}
              >
                {entry.icon}
                {entry.label}
              </Button>
            ))}
          </div>
        </ScrollArea>
      </nav>
      <ScrollArea slot="settings-body" className="flex-1">
        <div ref={body} className="flex max-w-2xl flex-col gap-8 px-4 py-6 md:px-8">
          {hits.length === 0 ? null : <SettingHits hits={hits} onOpen={open} onLeave={() => field.current?.focus()} />}
          {/* The Update row fails alone: a throw there must not take every section with it. */}
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
          <RegionBoundary
            key={section}
            region="settings-section"
            title="This section could not be drawn"
            detail="The other sections still open from the list."
          >
            {section === "device" ? (
              <>
                {joinedBrowser ? (
                  <Lead>This browser is a member of the mesh. Each machine has its own connection.</Lead>
                ) : (
                  <Lead>
                    This app talks to one host: the computer that runs your terminals. Here is which host it reaches,
                    whether it is there now, this device's own settings, and under Advanced connection the route this
                    app takes to that host. The defaults work for everyone; change them only for a self-hosted relay or
                    a development host.
                  </Lead>
                )}
                <Group title={joinedBrowser ? "This member" : "Host"}>
                  <DevicesSection />
                </Group>
                <Group title="This device">
                  <DeviceSection />
                </Group>
                {!joinedBrowser ? (
                  <Group title="Advanced connection">
                    <ConnectionSection />
                  </Group>
                ) : null}
              </>
            ) : section === "machines" ? (
              <>
                {joinedBrowser ? (
                  <Lead>These are the machines in your mesh. Each row shows this browser's own connection.</Lead>
                ) : (
                  <Lead>
                    These are the computers in your mesh that this host reaches. Connecting a machine joins it to your
                    mesh.
                  </Lead>
                )}
                <Group title="Machines">
                  {!joinedBrowser ? <MembersSection /> : null}
                  <MachinesSection />
                  {/* What a row's state means sits under the rows, where a reader meets it: on a phone the list leads (#1007). */}
                  {!joinedBrowser ? (
                    <p className="max-w-measure pt-3 text-prose text-pretty text-muted-foreground">
                      A machine that answers reads Connected, one still being dialled reads Connecting, and one that
                      needs a login says so; when a machine is offline the row says when it was last seen and, where the
                      host knows a cause, what it is.
                    </p>
                  ) : null}
                </Group>
                {/* Connecting a machine joins it to the mesh, so it is on this screen, under the rows it adds to. */}
                <Group title="Connect a machine" id={CONNECT_GROUP}>
                  <p className="pb-1 text-prose text-pretty text-muted-foreground">
                    One command on this host opens an invite, and the other computer or phone joins with it. A join
                    waits for your approval under In your mesh.
                  </p>
                  <PairSection />
                </Group>
                <Group title="In your mesh">
                  <BrowserInvite />
                  <MeshSection attentionOnly={joinedBrowser} />
                </Group>
              </>
            ) : section === "terminal" ? (
              <Group title="Terminal">
                <TerminalSection />
              </Group>
            ) : section === "keyboard" ? (
              // The section draws its own heading, because the heading row carries Edit and Done.
              <KeyboardSection />
            ) : section === "notifications" ? (
              <Group title="Notifications">
                <NotificationsSection />
              </Group>
            ) : section === "appearance" ? (
              <Group title="Appearance">
                <AppearanceSection />
              </Group>
            ) : section === "keybindings" ? (
              <Group title="Keybindings">
                <KeybindingsSection />
              </Group>
            ) : (
              <Group title="Voice input">
                <VoiceSection />
              </Group>
            )}
          </RegionBoundary>
        </div>
      </ScrollArea>
    </div>
  );
}
