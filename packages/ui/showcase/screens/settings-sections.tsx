import { Laptop, Smartphone, Tablet } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  BUILTIN_PALETTES,
  BUILTIN_THEMES,
  Button,
  Input,
  SegmentedControl,
  SettingRow,
  ThemeBrowser,
  isBuiltinThemeName,
  resolveTheme,
  type ThemeOption,
} from "../../src/index.ts";

const THEMES: readonly ThemeOption[] = Object.keys(BUILTIN_PALETTES)
  .filter(isBuiltinThemeName)
  .map((id) => ({
    id,
    name: BUILTIN_THEMES[id].name,
    source: [BUILTIN_THEMES[id].family, BUILTIN_THEMES[id].licence].filter(Boolean).join(" · "),
    theme: resolveTheme(BUILTIN_PALETTES[id]),
  }));

const DEVICES = [
  { id: "d1", name: "MacBook Pro", kind: <Laptop />, seen: "This device", current: true },
  { id: "d2", name: "iPhone", kind: <Smartphone />, seen: "Active 5 min ago", current: false },
  { id: "d3", name: "iPad", kind: <Tablet />, seen: "Active 3 days ago", current: false },
] as const;

export function Group({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col">
      <h2 className="pb-1 text-lg font-semibold text-foreground md:text-xl">{title}</h2>
      {children}
    </section>
  );
}

export function ConnectionSection() {
  const [route, setRoute] = useState<"relay" | "direct">("relay");
  return (
    <>
      <Group title="Connection">
        <SettingRow
          title="Connect through"
          description={
            route === "relay"
              ? "The relay works from anywhere and only forwards encrypted traffic."
              : "Only on the same network as the host. No relay involved."
          }
          control={
            <SegmentedControl
              label="Connect through"
              value={route}
              onValueChange={setRoute}
              options={[
                { value: "relay", label: "Relay" },
                { value: "direct", label: "Direct on LAN" },
              ]}
            />
          }
        />
        <SettingRow
          title="Relay address"
          description="Change it only for a relay you run yourself."
          control={
            <Input aria-label="Relay address" mono defaultValue="relay-doriface.omo.dev" className="w-full sm:w-64" />
          }
        />
      </Group>
      <Group title="Paired devices">
        {DEVICES.map((device) => (
          <SettingRow
            key={device.id}
            inline
            title={
              <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-muted-foreground">
                {device.kind}
                {device.name}
              </span>
            }
            description={device.seen}
            control={
              device.current ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Revoke ${device.name}`}
                  className="text-destructive hover:text-destructive"
                >
                  Revoke
                </Button>
              )
            }
          />
        ))}
      </Group>
    </>
  );
}

export function AppearanceSection() {
  const [mode, setMode] = useState<"system" | "light" | "dark">("system");
  const [picks, setPicks] = useState({ dark: "night", light: "day" });
  const [density, setDensity] = useState<"compact" | "comfortable" | "spacious">("comfortable");
  return (
    <Group title="Appearance">
      <SettingRow
        title="Appearance"
        description="System follows this device's light or dark setting."
        control={
          <SegmentedControl
            label="Appearance"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        }
      />
      <ThemeBrowser
        options={THEMES}
        dark={picks.dark}
        light={picks.light}
        defaultKind="dark"
        onPick={(id, kind) => setPicks((current) => ({ ...current, [kind]: id }))}
        className="border-b border-border"
      />
      <SettingRow
        title="Density"
        description="Row height in the sidebar, lists and menus. The terminal keeps its own font size."
        control={
          <SegmentedControl
            label="Density"
            value={density}
            onValueChange={setDensity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
              { value: "spacious", label: "Spacious" },
            ]}
          />
        }
      />
      <SettingRow
        title="Import a herdr-app theme"
        description="Any themes/<name>.json from herdr-app works unchanged."
        control={<Button size="sm">Choose file…</Button>}
      />
    </Group>
  );
}
