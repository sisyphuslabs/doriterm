import { Bell, Keyboard, Mic, MonitorSmartphone, Network, Palette, PanelBottom, SquareTerminal } from "lucide-react";

/** Settings' sections in the order the navigation lists them (DESIGN.md (d)). */
export const SECTIONS = [
  { id: "device", label: "This device", icon: <MonitorSmartphone /> },
  { id: "machines", label: "Machines", icon: <Network /> },
  { id: "terminal", label: "Terminal", icon: <SquareTerminal /> },
  { id: "keyboard", label: "Keyboard", icon: <PanelBottom /> },
  { id: "notifications", label: "Notifications", icon: <Bell /> },
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "keybindings", label: "Keybindings", icon: <Keyboard /> },
  { id: "voice", label: "Voice input", icon: <Mic /> },
] as const;

export type SettingsSection = (typeof SECTIONS)[number];
export type SectionId = SettingsSection["id"];

/** The id of the Connect a machine group on Machines: connecting a machine joins it to your mesh, so they are one screen. */
export const CONNECT_GROUP = "connect-a-machine";

/**
 * Links that name the Connect a machine group rather than a section: the join page's `#connect`, and `#pair` from when
 * Connect a machine was its own section.
 */
const GROUPS: Readonly<Record<string, { readonly section: SectionId; readonly group: string }>> = {
  pair: { section: "machines", group: CONNECT_GROUP },
  connect: { section: "machines", group: CONNECT_GROUP },
};

/** The section a link's hash asks for, and the group in it to show, else the one Settings always opens on. */
export function sectionFromLink(hash: string): { readonly section: SectionId; readonly group?: string } {
  const asked = hash.replace(/^#/, "");
  const group = Object.hasOwn(GROUPS, asked) ? GROUPS[asked] : undefined;
  if (group !== undefined) return group;
  const section = SECTIONS.find((entry) => entry.id === asked);
  return { section: section === undefined ? "device" : section.id };
}
