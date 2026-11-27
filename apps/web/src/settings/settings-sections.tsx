import { Bell, Keyboard, Mic, MonitorSmartphone, Network, Palette, PanelBottom, SquareTerminal } from "lucide-react";

/**
 * Settings' sections in the order the navigation lists them, under the caption of their group (DESIGN.md (d), #2914):
 * the phone's first screen and the side navigation draw the same groups. `tile` colours the icon's tile under a coarse
 * pointer; a fine one draws the icon bare, as the Herdr desktop app does.
 */
export const SECTIONS = [
  {
    id: "device",
    label: "This device",
    group: "Connection",
    tile: "coarse:bg-(--avatar-blue)",
    icon: <MonitorSmartphone />,
  },
  { id: "machines", label: "Machines", group: "Connection", tile: "coarse:bg-(--avatar-green)", icon: <Network /> },
  { id: "appearance", label: "Appearance", group: "Look", tile: "coarse:bg-(--avatar-violet)", icon: <Palette /> },
  { id: "terminal", label: "Terminal", group: "Look", tile: "coarse:bg-dim", icon: <SquareTerminal /> },
  { id: "keyboard", label: "Keyboard", group: "Input", tile: "coarse:bg-(--avatar-orange)", icon: <PanelBottom /> },
  { id: "keybindings", label: "Keybindings", group: "Input", tile: "coarse:bg-dim", icon: <Keyboard /> },
  { id: "voice", label: "Voice input", group: "Input", tile: "coarse:bg-(--avatar-pink)", icon: <Mic /> },
  { id: "notifications", label: "Notifications", group: "More", tile: "coarse:bg-(--avatar-teal)", icon: <Bell /> },
] as const;

/** The sections as the navigation groups them, groups in order, each with its sections in order. */
export function groupSections<Entry extends { readonly group: string }>(
  entries: readonly Entry[],
): readonly { readonly group: string; readonly entries: readonly Entry[] }[] {
  const groups: { group: string; entries: Entry[] }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last?.group === entry.group) last.entries.push(entry);
    else groups.push({ group: entry.group, entries: [entry] });
  }
  return groups;
}

export type SettingsSection = (typeof SECTIONS)[number];
export type SectionId = SettingsSection["id"];

/** The id of the From a terminal group on Machines: connecting a machine joins it to your mesh, so they are one screen. */
export const CONNECT_GROUP = "connect-a-machine";

/**
 * Links that name the From a terminal group rather than a section: the join page's `#connect`, and `#pair` from when
 * Connect a machine was its own section (now the From a terminal group on Machines).
 */
const GROUPS: Readonly<Record<string, { readonly section: SectionId; readonly group: string }>> = {
  pair: { section: "machines", group: CONNECT_GROUP },
  connect: { section: "machines", group: CONNECT_GROUP },
};

/**
 * The section a link's hash asks for, and the group in it to show, else the one Settings always opens on. `named` says
 * the link named one: a phone opens that section's page, and otherwise its list of sections.
 */
export function sectionFromLink(hash: string): {
  readonly section: SectionId;
  readonly group?: string;
  readonly named: boolean;
} {
  const asked = hash.replace(/^#/, "");
  const group = Object.hasOwn(GROUPS, asked) ? GROUPS[asked] : undefined;
  if (group !== undefined) return { ...group, named: true };
  const section = SECTIONS.find((entry) => entry.id === asked);
  return section === undefined ? { section: "device", named: false } : { section: section.id, named: true };
}
