import type { ComponentType } from "react";
import { ApprovalScreen } from "./screens/approval.tsx";
import { MobileAgentsScreen, MobileScreen } from "./screens/mobile.tsx";
import { PairScreen } from "./screens/pair.tsx";
import { PaletteScreen } from "./screens/palette.tsx";
import { PrimitivesScreen } from "./screens/primitives.tsx";
import {
  SettingsAppearanceScreen,
  SettingsDeviceScreen,
  SettingsKeyboardScreen,
  SettingsScreen,
  SettingsTerminalScreen,
} from "./screens/settings.tsx";
import { ShellScreen } from "./screens/shell.tsx";
import { StatesScreen } from "./screens/states.tsx";
import { VoiceScreen } from "./screens/voice.tsx";

export const ROUTES = [
  { id: "primitives", title: "Primitives", render: PrimitivesScreen },
  { id: "shell", title: "Workspace shell", render: ShellScreen },
  { id: "pair", title: "Connect and pair", render: PairScreen },
  { id: "palette", title: "Command palette", render: PaletteScreen },
  { id: "settings", title: "Settings", render: SettingsScreen },
  { id: "settings-appearance", title: "Settings: appearance", render: SettingsAppearanceScreen },
  { id: "settings-device", title: "Settings: device", render: SettingsDeviceScreen },
  { id: "settings-terminal", title: "Settings: terminal", render: SettingsTerminalScreen },
  { id: "settings-keyboard", title: "Settings: keyboard", render: SettingsKeyboardScreen },
  { id: "mobile", title: "Phone", render: MobileScreen },
  { id: "mobile-agents", title: "Phone agents list", render: MobileAgentsScreen },
  { id: "states", title: "Empty, offline and error states", render: StatesScreen },
  { id: "approval", title: "Permission banner", render: ApprovalScreen },
  { id: "voice", title: "Voice input", render: VoiceScreen },
] as const satisfies readonly { id: string; title: string; render: ComponentType }[];

export type RouteId = (typeof ROUTES)[number]["id"];
