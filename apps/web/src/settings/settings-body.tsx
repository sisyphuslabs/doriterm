import { cn } from "@doriface/ui";
import type { ReactNode } from "react";
import { desktopMcp } from "../desktop/mcp-bridge.ts";
import { AppearanceSection } from "./appearance-section.tsx";
import { BrowserInvite } from "./browser-invite.tsx";
import { ConnectionSection } from "./connection-section.tsx";
import { DeviceSection } from "./device-section.tsx";
import { DevicesSection } from "./devices-section.tsx";
import { KeybindingsSection } from "./keybindings-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { MachinesSection } from "./machines-section.tsx";
import { McpSection } from "./mcp-section.tsx";
import { MembersSection } from "./members-section.tsx";
import { MeshSection } from "./mesh-section.tsx";
import { NotificationsSection } from "./notifications-section.tsx";
import { PairSection } from "./pair-section.tsx";
import { SectionHeader, SettingsCard } from "./settings-layout.tsx";
import { CONNECT_GROUP, type SectionId } from "./settings-sections.tsx";
import { TerminalSection } from "./terminal-section.tsx";
import { VoiceSection } from "./voice-section.tsx";

/**
 * One group of a section: its caption, then its rows on a card. A group named as its section (`named`) has no caption on
 * a phone, whose page already has that name as its title (`h1`): one heading, not two of the same name.
 */
export function Group({
  title,
  id,
  named = false,
  children,
}: {
  readonly title: string;
  readonly id?: string;
  readonly named?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <div className={cn(named && "max-md:hidden")}>
        <SectionHeader title={title} {...(id === undefined ? {} : { id })} />
      </div>
      <SettingsCard>{children}</SettingsCard>
    </section>
  );
}

/** One sentence under the title, in the words the navigation uses: what this screen is about and nothing else. */
function Lead({ children }: { readonly children: ReactNode }) {
  return (
    <p className="max-w-measure px-(--settings-caption-inset) text-(length:--settings-row-detail) leading-5 text-pretty text-muted-foreground">
      {children}
    </p>
  );
}

/** The groups of one section, as both the phone's section page and the wide layout's form draw them. */
export function SectionBody({
  section,
  joinedBrowser,
}: {
  readonly section: SectionId;
  readonly joinedBrowser: boolean;
}) {
  switch (section) {
    case "device":
      return (
        <>
          {joinedBrowser ? (
            <Lead>This browser is a member of the mesh. Each machine has its own connection.</Lead>
          ) : (
            <Lead>
              This app talks to one host: the computer that runs your terminals. Here is which host it reaches, whether
              it is there now, this device's own settings, and under Advanced connection the route this app takes to
              that host. The defaults work for everyone; change them only for a self-hosted relay or a development host.
            </Lead>
          )}
          <Group title={joinedBrowser ? "This member" : "Host"}>
            <DevicesSection />
          </Group>
          <Group title="This device">
            <DeviceSection />
          </Group>
          {!joinedBrowser && desktopMcp() !== null ? (
            <Group title="MCP">
              <McpSection />
            </Group>
          ) : null}
          {!joinedBrowser ? (
            <Group title="Advanced connection">
              <ConnectionSection />
            </Group>
          ) : null}
        </>
      );
    case "machines":
      return (
        <>
          {joinedBrowser ? (
            <Lead>These are the machines in your mesh. Each row shows this browser's own connection.</Lead>
          ) : (
            <Lead>
              These are the computers in your mesh that this host reaches. Connecting a machine joins it to your mesh.
            </Lead>
          )}
          <Group title="Machines" named>
            {!joinedBrowser ? <MembersSection /> : null}
            <MachinesSection />
            {/* What a row's state means sits under the rows, where a reader meets it: on a phone the list leads (#1007). */}
            {!joinedBrowser ? (
              <p className="max-w-measure py-3 text-(length:--settings-row-detail) leading-5 text-pretty text-muted-foreground">
                A machine that answers reads Connected, one still being dialled reads Connecting, and one that needs a
                login says so; when a machine is offline the row says when it was last seen and, where the host knows a
                cause, what it is.
              </p>
            ) : null}
          </Group>
          {/* Connecting a machine joins it to the mesh, so it is on this screen, under the rows it adds to. */}
          <Group title="Connect a machine" id={CONNECT_GROUP}>
            <p className="py-3 text-(length:--settings-row-detail) leading-5 text-pretty text-muted-foreground">
              One command on this host opens an invite, and the other computer or phone joins with it. A join waits for
              your approval under In your mesh.
            </p>
            <PairSection />
          </Group>
          <Group title="In your mesh">
            <BrowserInvite />
            <MeshSection attentionOnly={joinedBrowser} />
          </Group>
        </>
      );
    case "terminal":
      return (
        <Group title="Terminal" named>
          <TerminalSection />
        </Group>
      );
    case "keyboard":
      // The section draws its own heading, because the heading row carries Edit and Done.
      return <KeyboardSection />;
    case "notifications":
      return (
        <Group title="Notifications" named>
          <NotificationsSection />
        </Group>
      );
    case "appearance":
      return (
        <Group title="Appearance" named>
          <AppearanceSection />
        </Group>
      );
    case "keybindings":
      return (
        <Group title="Keybindings" named>
          <KeybindingsSection />
        </Group>
      );
    case "voice":
      return (
        <Group title="Voice input" named>
          <VoiceSection />
        </Group>
      );
  }
}
