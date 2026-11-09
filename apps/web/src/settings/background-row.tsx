import { SettingRow, Switch } from "@doriface/ui";
import { useEffect, useState } from "react";
import type { BackgroundSetting } from "../desktop/bridge.ts";

const TITLE = "Keep running in the background";

/**
 * The desktop app's Keep running in the background (#1500). The switch waits for the shell's saved answer before it
 * takes a click, and goes back when the shell did not keep a change.
 */
export function BackgroundRow({ setting }: { readonly setting: BackgroundSetting }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setting.read().then(
      (saved) => live && setEnabled(saved),
      (error: unknown) => console.error(`run in background: ${String(error)}`),
    );
    return () => {
      live = false;
    };
  }, [setting]);
  const change = (checked: boolean): void => {
    setEnabled(checked);
    setting.set(checked).then(
      (kept) => kept || setEnabled(!checked),
      (error: unknown) => {
        console.error(`run in background: ${String(error)}`);
        setEnabled(!checked);
      },
    );
  };
  const hidden = setting.mac
    ? "Closing the window also removes Doriterm from the Dock and the menu bar"
    : "Closing the window keeps Doriterm running without one";
  return (
    <SettingRow
      inline
      title={TITLE}
      description={`${hidden}, so your phone stays connected to this computer. Open Doriterm again to bring the window back.`}
      control={
        <Switch aria-label={TITLE} checked={enabled ?? false} disabled={enabled === null} onCheckedChange={change} />
      }
    />
  );
}
