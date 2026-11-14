import type { Terminal } from "@doriface/protocol";
import { CommandPalette } from "@doriface/ui";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef } from "react";
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
    return paletteCommands({
      terminals,
      host,
      route,
      actions,
      platform,
      keymap: resolveKeymap(platform, overrides),
      spaceOf: spaceNameOf(spaces),
    });
  }, [terminals, host, route, actions, spaces, overrides]);
  const frame = useRef<HTMLDivElement>(null);
  useOverlayFocus(frame, '[role="combobox"]');
  const run = (id: string): void => {
    const choice = choiceOf(id);
    // An action nobody took leaves the palette open on its row instead of closing on nothing.
    if (choice.kind === "action") return void (runAction(choice.id) && onClose());
    onClose();
    if (choice.kind === "agent") onOpenTerminal(choice.address);
    else void navigate({ to: "/settings" });
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
