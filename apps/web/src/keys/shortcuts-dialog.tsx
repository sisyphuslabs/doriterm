import { Dialog, ShortcutList } from "@doriface/ui";
import { useEffect, useMemo } from "react";
import { resolveKeymap } from "./keymap.ts";
import { useOverrides } from "./keymap-store.ts";
import { shortcutGroups } from "./shortcut-groups.ts";
import { closeShortcuts, useShortcutsShown } from "./shortcuts-store.ts";
import { currentPlatform } from "./trigger.ts";

/** The shortcuts dialog while app.help has it shown; each shell's action handler toggles it. */
export function ShortcutsHelp() {
  useEffect(() => closeShortcuts, []);
  return useShortcutsShown() ? <ShortcutsDialog onClose={closeShortcuts} /> : null;
}

export interface ShortcutsDialogProps {
  readonly onClose: () => void;
}

/** herdr-app's app.help: the keymap in force, read-only; Settings > Keybindings is where a key changes. */
export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const overrides = useOverrides();
  const groups = useMemo(() => {
    const platform = currentPlatform();
    return shortcutGroups(resolveKeymap(platform, overrides), platform);
  }, [overrides]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      finalFocus={() => true}
      title="Keyboard shortcuts"
      description="Your keys as they are set now. Change them in Settings > Keybindings."
      className="w-[min(36rem,calc(100%-2rem))]"
    >
      <ShortcutList groups={groups} />
    </Dialog>
  );
}
