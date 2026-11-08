import { Button, IconButton, Input, ScrollArea, Tab, TabList, Tabs, cn } from "@doriface/ui";
import { ArrowLeft } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { currentPlatform, triggerKeys } from "../keys/trigger.ts";
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
import { SECTIONS, type SectionId } from "../settings/settings-sections.tsx";
import { matchSections } from "../settings/settings-search.ts";
import { matchSettings, type SettingHit } from "../settings/setting-rows.ts";
import { SettingHits, useLandOn } from "../settings/settings-hits.tsx";

/** The section a link asked for (a hash, so it survives a reload), else the one Settings always opens on. */
function firstSection(): SectionId {
  const asked = window.location.hash.slice(1);
  return SECTIONS.some((entry) => entry.id === asked) ? (asked as SectionId) : "device";
}

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="pb-1 text-lg font-semibold text-foreground md:text-xl">{title}</h2>
      {children}
    </section>
  );
}

/** One sentence under the title, in the words the navigation uses: what this screen is about and nothing else. */
function Lead({ children }: { readonly children: ReactNode }) {
  return <p className="text-prose text-pretty text-muted-foreground">{children}</p>;
}

/** Section navigation beside the form; changes apply as they are made. */
export function SettingsRoute() {
  const [section, setSection] = useState<SectionId>(firstSection);
  const [query, setQuery] = useState("");
  const shown = matchSections(SECTIONS, query);
  const hits = matchSettings(query);
  const [landing, setLanding] = useState<SettingHit | null>(null);
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
  const search = (
    <Input
      ref={field}
      aria-label="Search settings"
      type="search"
      placeholder="Search settings"
      value={query}
      onValueChange={(next: string) => {
        setQuery(next);
        setLanding(null);
      }}
      onKeyDown={(event) => {
        const [hit] = hits;
        const first = shown[0];
        if (event.key === "ArrowDown" && hit !== undefined) {
          event.preventDefault();
          body.current?.querySelector<HTMLElement>("[data-setting-hits] button")?.focus();
        } else if (event.key === "Enter" && hit !== undefined) open(hit);
        else if (event.key === "Enter" && first !== undefined) setSection(first.id);
      }}
    />
  );
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
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
          {/* In the title row, so the phone header keeps its height and the sections below do not move (#1460). */}
          <div className="ml-2 min-w-0 flex-1">{search}</div>
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
        className="hidden w-56 shrink-0 flex-col gap-px border-r border-sidebar-border bg-sidebar px-2 pb-2 md:flex"
      >
        <div
          {...titlebar}
          className={cn(
            "mb-1 flex h-11 shrink-0 items-center gap-1",
            !dialog && "pl-[calc(var(--titlebar-inset-start,0.5rem)-0.5rem)]",
          )}
        >
          {back}
          <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        </div>
        <div className="mb-1">{search}</div>
        {nothing}
        {shown.map((entry) => (
          <Button
            key={entry.id}
            variant="ghost"
            aria-current={entry.id === section ? "page" : undefined}
            onClick={() => setSection(entry.id)}
            className={cn(
              "justify-start gap-2.5 px-2 text-sm [&_svg]:size-3.5",
              entry.id === section && "bg-selected text-foreground",
            )}
          >
            {entry.icon}
            {entry.label}
          </Button>
        ))}
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
                    These are the computers this host reaches: the ones that joined your mesh, and any you added by
                    hand.
                  </Lead>
                )}
                <Group title="Machines">
                  {!joinedBrowser ? <MembersSection /> : null}
                  <MachinesSection />
                  {/* What a row's state means sits under the rows, where a reader meets it: on a phone the list leads (#1007). */}
                  {!joinedBrowser ? (
                    <p className="pt-3 text-prose text-pretty text-muted-foreground">
                      Adding one by hand reaches it without the mesh; connecting one joins it first. A machine that
                      answers reads Connected, one still being dialled reads Connecting, and one that needs a login says
                      so; when a machine is offline the row says when it was last seen and, where the host knows a
                      cause, what it is.
                    </p>
                  ) : null}
                </Group>
                <Group title="In your mesh">
                  <BrowserInvite />
                  <MeshSection attentionOnly={joinedBrowser} />
                </Group>
              </>
            ) : section === "pair" ? (
              <>
                <Lead>
                  Connecting a machine joins it to your mesh: one command on this host opens an invite, and the other
                  computer or phone joins with it. A join waits for your approval under Machines before that machine is
                  reachable.
                </Lead>
                <Group title="Connect a machine">
                  <PairSection />
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
