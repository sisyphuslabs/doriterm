import { Button, IconButton, ScrollArea, Tab, TabList, Tabs, cn } from "@doriface/ui";
import { ArrowLeft, Keyboard, Link2, Network, Palette, SquareTerminal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { currentPlatform, triggerKeys } from "../keys/trigger.ts";
import { AppearanceSection } from "../settings/appearance-section.tsx";
import { ConnectionSection } from "../settings/connection-section.tsx";
import { DevicesSection } from "../settings/devices-section.tsx";
import { KeybindingsSection } from "../settings/keybindings-section.tsx";
import { MeshSection } from "../settings/mesh-section.tsx";
import { TerminalSection } from "../settings/terminal-section.tsx";
import { useCloseSettings } from "../settings/use-close-settings.ts";

const SECTIONS = [
  { id: "connections", label: "Connections", icon: <Link2 /> },
  { id: "mesh", label: "Mesh", icon: <Network /> },
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "terminal", label: "Terminal", icon: <SquareTerminal /> },
  { id: "keybindings", label: "Keybindings", icon: <Keyboard /> },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="pb-1 text-lg font-semibold text-foreground md:text-xl">{title}</h2>
      {children}
    </section>
  );
}

/** Section navigation beside the form; changes apply as they are made. */
export function SettingsRoute() {
  const [section, setSection] = useState<SectionId>("connections");
  const close = useCloseSettings();
  const back = (
    <IconButton
      label="Close settings"
      keys={triggerKeys("escape", currentPlatform())}
      icon={<ArrowLeft />}
      onClick={close}
    />
  );
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background md:flex-row">
      <Tabs value={section} onValueChange={(value: SectionId) => setSection(value)} className="md:hidden">
        <div data-titlebar className="flex items-center gap-1 pt-3 pr-2 pb-1 pl-[var(--titlebar-inset-start,0.5rem)]">
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
          data-titlebar
          className="mb-1 flex h-11 shrink-0 items-center gap-1 pl-[calc(var(--titlebar-inset-start,0.5rem)-0.5rem)]"
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
          {section === "connections" ? (
            <>
              <Group title="Connection">
                <ConnectionSection />
              </Group>
              <Group title="Paired devices">
                <DevicesSection />
              </Group>
            </>
          ) : section === "mesh" ? (
            <Group title="Mesh">
              <MeshSection />
            </Group>
          ) : section === "appearance" ? (
            <Group title="Appearance">
              <AppearanceSection />
            </Group>
          ) : section === "terminal" ? (
            <Group title="Terminal">
              <TerminalSection />
            </Group>
          ) : (
            <Group title="Keybindings">
              <KeybindingsSection />
            </Group>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
