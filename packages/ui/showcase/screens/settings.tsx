import { ChevronLeft, Keyboard, Link2, MonitorSmartphone, Palette, SquareTerminal, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, IconButton, ScrollArea, Tab, TabList, Tabs, cn } from "../../src/index.ts";
import { DeviceSection } from "./settings-device.tsx";
import { KeyboardSection } from "./settings-keyboard.tsx";
import { AppearanceSection, ConnectionSection } from "./settings-sections.tsx";
import { TerminalSection } from "./settings-terminal.tsx";

export type SettingsSection = "connection" | "appearance" | "device" | "terminal" | "keyboard";

const SECTIONS = [
  { id: "connection", label: "Connection", icon: <Link2 /> },
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "device", label: "Device", icon: <MonitorSmartphone /> },
  { id: "terminal", label: "Terminal", icon: <SquareTerminal /> },
  { id: "keyboard", label: "Keyboard", icon: <Keyboard /> },
] as const;

const BODY: Readonly<Record<SettingsSection, () => ReactNode>> = {
  connection: () => <ConnectionSection />,
  appearance: () => <AppearanceSection />,
  device: () => <DeviceSection />,
  terminal: () => <TerminalSection />,
  keyboard: () => <KeyboardSection />,
};

/**
 * List-detail settings: section navigation beside the section's form. Every section stays mounted in its own
 * scroller, so switching back keeps both its scroll position and its choices.
 */
export function SettingsScreen({ section: initial = "connection" }: { readonly section?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background md:flex-row">
      <Tabs
        value={section}
        onValueChange={(value) => setSection(SECTIONS.find((entry) => entry.id === value)?.id ?? section)}
        className="md:hidden"
      >
        <header className="box-content flex h-12 items-center gap-1 px-1.5 pt-(--safe-top)">
          <IconButton label="Back to agents" icon={<ChevronLeft />} size="md" />
          <h1 className="text-xl font-semibold text-foreground">Settings</h1>
        </header>
        <TabList className="scroll-px-2 px-2 pt-1">
          {SECTIONS.map((entry) => (
            <Tab key={entry.id} value={entry.id}>
              {entry.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>
      <nav
        aria-label="Settings"
        className="hidden w-56 shrink-0 flex-col gap-px border-r border-sidebar-border bg-sidebar p-2 md:flex"
      >
        <div className="flex items-center gap-1 pt-1 pb-2 pl-2">
          <h1 className="flex-1 text-lg font-semibold text-foreground">Settings</h1>
          <IconButton label="Close settings" keys={["esc"]} icon={<X />} />
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
      {SECTIONS.map((entry) => (
        <ScrollArea
          key={entry.id}
          {...(entry.id === section ? { slot: "settings-body" } : {})}
          className={cn("flex-1", entry.id !== section && "hidden")}
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-6 pb-[max(1.5rem,var(--safe-bottom))] md:px-8">
            {BODY[entry.id]()}
          </div>
        </ScrollArea>
      ))}
    </div>
  );
}

export function SettingsAppearanceScreen() {
  return <SettingsScreen section="appearance" />;
}

export function SettingsDeviceScreen() {
  return <SettingsScreen section="device" />;
}

export function SettingsTerminalScreen() {
  return <SettingsScreen section="terminal" />;
}

export function SettingsKeyboardScreen() {
  return <SettingsScreen section="keyboard" />;
}
