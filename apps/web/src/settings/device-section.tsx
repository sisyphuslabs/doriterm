import { Button, SettingRow, Switch } from "@doriface/ui";
import { install, useInstallOffer } from "../device/install.ts";
import { keepAwakeStore, screenWakeLock, useKeepAwake } from "../device/keep-awake.ts";

/** Settings that belong to this browser or device rather than to an account: the screen, and installing the app. */
export function DeviceSection() {
  const keepAwake = useKeepAwake();
  const offer = useInstallOffer();
  const rows = [
    screenWakeLock() === null ? null : (
      <SettingRow
        key="keep-awake"
        inline
        title="Keep the screen awake"
        description="While a terminal is on screen. Released when you switch away."
        control={
          <Switch
            aria-label="Keep the screen awake"
            checked={keepAwake}
            onCheckedChange={(checked) => keepAwakeStore.set(checked)}
          />
        }
      />
    ),
    offer?.kind === "prompt" ? (
      <SettingRow
        key="install"
        inline
        title="Install doriface"
        description="Opens in its own window, from the Dock or the home screen."
        control={
          <Button size="sm" onClick={() => void install(offer.prompt)}>
            Install
          </Button>
        }
      />
    ) : offer?.kind === "ios" ? (
      <SettingRow
        key="install"
        title="Add to Home Screen"
        description="In Safari, tap Share, then Add to Home Screen. doriface then opens in its own window."
        control={null}
      />
    ) : null,
  ].filter((row) => row !== null);
  return rows.length === 0 ? (
    <p className="py-3 text-sm text-muted-foreground">This browser has no device settings.</p>
  ) : (
    <div className="flex flex-col">{rows}</div>
  );
}
