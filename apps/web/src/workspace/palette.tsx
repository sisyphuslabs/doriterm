import type { Terminal } from "@doriface/protocol";
import { CommandPalette, type Command } from "@doriface/ui";
import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Columns2,
  Folder,
  FolderPlus,
  HelpCircle,
  Keyboard,
  ListFilter,
  Mic,
  MonitorSmartphone,
  Palette as PaletteIcon,
  PanelLeft,
  Plus,
  Rows2,
  Search,
  Server,
  Settings,
  Terminal as TerminalIcon,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";
import { resolveKeymap } from "../keys/keymap.ts";
import { useOverrides } from "../keys/keymap-store.ts";
import { runAction } from "../keys/dispatcher.ts";
import { currentPlatform } from "../keys/trigger.ts";
import { useOverlayActive } from "../keys/use-overlay-active.ts";
import { choiceOf, paletteCommands, spaceNameOf } from "./palette-commands.ts";
import type { ListedSpace } from "./model.ts";
import { useShown } from "./use-shown.ts";
import type { ShellAction } from "./shell-actions.ts";
import { useOverlayFocus } from "./use-overlay-focus.ts";

const SETTINGS_JUMPS: readonly Command[] = [
  { id: "settings:appearance", label: "Settings: Appearance", group: "General", icon: <PaletteIcon aria-hidden /> },
  { id: "settings:terminal", label: "Settings: Terminal", group: "General", icon: <TerminalIcon aria-hidden /> },
  { id: "settings:keybindings", label: "Settings: Keybindings", group: "General", icon: <Keyboard aria-hidden /> },
  { id: "settings:machines", label: "Settings: Machines", group: "General", icon: <Server aria-hidden /> },
  { id: "settings:device", label: "Settings: This device", group: "General", icon: <MonitorSmartphone aria-hidden /> },
  { id: "settings:notifications", label: "Settings: Notifications", group: "General", icon: <Bell aria-hidden /> },
  { id: "settings:voice", label: "Settings: Voice input", group: "General", icon: <Mic aria-hidden /> },
];

function commandIcon(command: Command): ReactNode | undefined {
  if (command.icon !== undefined) return command.icon;
  if (command.id.startsWith("agent:")) return <TerminalIcon aria-hidden />;
  if (command.id.startsWith("host:")) return <Server aria-hidden />;
  switch (command.id) {
    case "tab.new":
      return <Plus aria-hidden />;
    case "tab.close":
    case "pane.close":
      return <X aria-hidden />;
    case "pane.split:right":
      return <Columns2 aria-hidden />;
    case "pane.split:down":
      return <Rows2 aria-hidden />;
    case "layout.toggle:sidebar":
      return <PanelLeft aria-hidden />;
    case "layout.filter:sidebar":
      return <ListFilter aria-hidden />;
    case "space.new":
      return <FolderPlus aria-hidden />;
    case "terminal.find":
      return <Search aria-hidden />;
    case "terminal.dictate":
      return <Mic aria-hidden />;
    case "app.zoom_in":
      return <ZoomIn aria-hidden />;
    case "app.zoom_out":
      return <ZoomOut aria-hidden />;
    case "app.settings":
      return <Settings aria-hidden />;
    case "app.help":
      return <HelpCircle aria-hidden />;
    default:
      return undefined;
  }
}

export interface PaletteProps {
  readonly terminals: readonly Terminal[];
  readonly host: string;
  readonly route: string;
  readonly actions: readonly ShellAction[];
  /** The spaces as the sidebar lists them, to name an agent's space the same way. */
  readonly spaces: readonly ListedSpace[];
  readonly onOpenTerminal: (address: string) => void;
  readonly onClose: () => void;
}

/** The palette over the dimmed workspace, near the top; Escape or the backdrop closes it. */
export function Palette({ terminals: listed, host, route, actions, spaces, onOpenTerminal, onClose }: PaletteProps) {
  const terminals = useShown(listed);
  const active = useOverlayActive(onClose);
  const navigate = useNavigate();
  const overrides = useOverrides();
  const commands = useMemo(() => {
    const platform = currentPlatform();
    const base = paletteCommands({
      terminals,
      host,
      route,
      actions,
      platform,
      keymap: resolveKeymap(platform, overrides),
      spaceOf: spaceNameOf(spaces),
    }).map((command) => {
      const icon = commandIcon(command);
      return icon === undefined ? command : Object.assign({}, command, { icon });
    });
    const spaceCommands: Command[] = spaces.flatMap((space): Command[] => {
      const first = space.addresses[0];
      if (first === undefined) return [];
      return [
        {
          id: `space:${first}`,
          label: space.name,
          group: "Spaces",
          icon: <Folder aria-hidden />,
          hint: `${space.tabs} ${space.tabs === 1 ? "tab" : "tabs"}`,
        },
      ];
    });
    const firstNonAgent = base.findIndex((command) => command.group !== "Agents");
    const withSpaces =
      firstNonAgent === -1
        ? [...base, ...spaceCommands]
        : [...base.slice(0, firstNonAgent), ...spaceCommands, ...base.slice(firstNonAgent)];
    return [...withSpaces, ...SETTINGS_JUMPS];
  }, [terminals, host, route, actions, spaces, overrides]);
  const frame = useRef<HTMLDivElement>(null);
  useOverlayFocus(frame, '[role="combobox"]');
  const run = (id: string): void => {
    if (id.startsWith("space:")) {
      onClose();
      onOpenTerminal(id.slice("space:".length));
      return;
    }
    const choice = choiceOf(id);
    // An action nobody took leaves the palette open on its row instead of closing on nothing.
    if (choice.kind === "action") return void (runAction(choice.id) && onClose());
    onClose();
    if (choice.kind === "agent") onOpenTerminal(choice.address);
    else void navigate({ to: "/settings", ...(choice.hash === undefined ? {} : { hash: choice.hash }) });
  };
  return active ? (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal
        aria-label="Command palette"
        ref={frame}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
        }}
        className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[calc(var(--safe-top)+0.75rem)] md:pt-[12vh] [&>*]:pointer-events-auto"
      >
        <CommandPalette commands={commands} onRun={run} onCancel={onClose} />
      </div>
    </>
  ) : null;
}
