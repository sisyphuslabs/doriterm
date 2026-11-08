import {
  Bell,
  Keyboard,
  Mic,
  MonitorSmartphone,
  Network,
  Palette,
  PanelBottom,
  Plug,
  SquareTerminal,
} from "lucide-react";

/** Settings' sections in the order the navigation lists them (DESIGN.md (d)). */
export const SECTIONS = [
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

export type SettingsSection = (typeof SECTIONS)[number];
export type SectionId = SettingsSection["id"];
