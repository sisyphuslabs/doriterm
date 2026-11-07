import { Button, IconButton, ScrollArea, Tab, TabList, Tabs, cn } from "@doriface/ui";
import { ArrowLeft, Bell, Keyboard, Mic, Network, Palette, PanelBottom, Plug, SquareTerminal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { MonitorSmartphone } from "lucide-react";
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
import { useMeshMembers } from "../connection/store.ts";
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

const SECTIONS = [
  { id: "device", label: "This device", icon: <MonitorSmartphone /> },
  { id: "machines", label: "Machines", icon: <Network /> },
  { id: "pair", label: "Connect a machine", icon: <Plug /> },
  { id: "terminal", label: "Terminal", icon: <SquareTerminal /> },
  { id: "keyboard", label: "Keyboard", icon: <PanelBottom /> },
  { id: "notifications", label: "Notifications", icon: <Bell /> },
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "keybindings", label: "Keybindings", icon: <Keyboard /> },
  { id: "voice", label: "Voice input", icon: <Mic /> },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

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
  return <p className="text-sm text-pretty text-muted-foreground">{children}</p>;
}

/** Section navigation beside the form; changes apply as they are made. */
export function SettingsRoute() {
  const [section, setSection] = useState<SectionId>(firstSection);
  const members = useMeshMembers();
  const close = useCloseSettings();
  const update = usePendingUpdate();
  // In the dialog its header is not the window's titlebar: it neither moves the window nor makes room for its controls.
  const dialog = useSettingsInDialog();
  const titlebar = dialog ? {} : { "data-titlebar": "" };
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
      className={cn(
        "flex h-full min-h-0 flex-col bg-background md:flex-row",
        !dialog && "pt-(--safe-top) pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left)",
      )}
    >
      <CrashProbe region="settings" />
      <Tabs value={section} onValueChange={(value: SectionId) => setSection(value)} className="md:hidden">
        <div {...titlebar} className="flex items-center gap-1 pt-3 pr-2 pb-1 pl-[var(--titlebar-inset-start,0.5rem)]">
          {back}
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        </div>
        <TabList className="scroll-px-2 px-2">
          {SECTIONS.map((entry) => (
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
        {SECTIONS.map((entry) => (
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
        <div className="flex max-w-2xl flex-col gap-8 px-4 py-6 md:px-8">
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
                <Lead>
                  This app talks to one host: the computer that runs your terminals. Here is which host it reaches,
                  whether it is there now, this device's own settings, and under Advanced connection the route this app
                  takes to that host. The defaults work for everyone; change them only for a self-hosted relay or a
                  development host.
                </Lead>
                <Group title="Host">
                  <DevicesSection />
                </Group>
                <Group title="This device">
                  <DeviceSection />
                </Group>
                <Group title="Advanced connection">
                  <ConnectionSection />
                </Group>
              </>
            ) : section === "machines" ? (
              <>
                <Lead>
                  These are the computers this host reaches: the ones that joined your mesh, and any you added by hand.
                </Lead>
                <Group title="Machines">
                  {members.length > 1 ? <MembersSection /> : null}
                  <MachinesSection />
                  {/* What a row's state means sits under the rows, where a reader meets it: on a phone the list leads (#1007). */}
                  <p className="pt-3 text-sm text-pretty text-muted-foreground">
                    Adding one by hand reaches it without the mesh; connecting one joins it first. A machine that
                    answers reads Connected, one still being dialled reads Connecting, and one that needs a login says
                    so; when a machine is offline the row says when it was last seen and, where the host knows a cause,
                    what it is.
                  </p>
                </Group>
                <Group title="In your mesh">
                  <MeshSection />
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
