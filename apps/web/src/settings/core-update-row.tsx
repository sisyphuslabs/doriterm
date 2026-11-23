import { Button, SettingRow } from "@doriface/ui";
import { useState } from "react";
import type { CoreUpdateSetting, CoreUpdateStatus } from "../desktop/core-update-setting.ts";

function description(status: CoreUpdateStatus | undefined): string {
  switch (status?.state) {
    case undefined:
      return "Checks for a newer herdr-core on this computer.";
    case "available":
      return `Installed: ${status.current}. Available: ${status.version}. Terminals stay open while the core reconnects.`;
    case "current":
      return `herdr-core ${status.version} is up to date.`;
    case "updated":
      return `herdr-core ${status.version} is running.`;
    case "restored":
      return `The update failed. herdr-core ${status.version} was restored and is running.`;
    case "unavailable":
    case "failed":
      return status.message;
  }
}

export function CoreUpdateRow({ setting }: { readonly setting: CoreUpdateSetting }) {
  const [status, setStatus] = useState<CoreUpdateStatus>();
  const [busy, setBusy] = useState(false);
  const offered = status?.state === "available";
  const act = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await (offered ? setting.apply() : setting.check()));
    } catch {
      setStatus({ state: "failed", message: "Doriterm could not reach the core updater." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      inline
      title="herdr-core"
      description={
        <span role="status">
          {busy ? (offered ? "Updating herdr-core…" : "Checking for updates…") : description(status)}
        </span>
      }
      control={
        <Button size="sm" variant={offered ? "primary" : "secondary"} loading={busy} onClick={() => void act()}>
          {offered ? `Update to ${status.version}` : "Check for core updates"}
        </Button>
      }
    />
  );
}
