import { Button, SegmentedControl, SettingRow } from "@doriface/ui";
import { useEffect, useState } from "react";
import type { DesktopUpdateStatus, UpdateChannel, UpdateSetting } from "../desktop/update-setting.ts";

const CHANNELS = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
] as const;

/** One line per updater state, so a failed check, a stalled download and a build too old to update are each named. */
export function statusLine(status: DesktopUpdateStatus | null): string {
  if (status === null) return "Updates come from get.doriterm.com.";
  switch (status.state) {
    case "idle":
      return "Doriterm checks for updates at launch and every four hours.";
    case "checking":
      return "Checking for an update…";
    case "current":
      return "Doriterm is up to date.";
    case "downloading":
      return `Downloading Doriterm ${status.version} (${status.percent}%).`;
    case "ready":
      return `Doriterm ${status.version} is downloaded; restart to install it.`;
    case "failed":
      return status.reason === "check" ? `The update check failed: ${status.message}` : status.message;
  }
}

/**
 * The desktop app's Update channel (#1969): stable by default, beta for prereleases. The control waits for the shell's
 * saved channel and goes back when the shell did not keep a change; the description is the updater's status.
 */
export function UpdateChannelRow({ setting }: { readonly setting: UpdateSetting }) {
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  useEffect(() => {
    let live = true;
    setting.channel().then(
      (saved) => live && setChannel(saved),
      (error: unknown) => console.error(`update channel: ${String(error)}`),
    );
    setting.onStatus((next) => live && setStatus(next));
    return () => {
      live = false;
    };
  }, [setting]);
  const change = (next: UpdateChannel): void => {
    const was = channel;
    setChannel(next);
    setting.setChannel(next).then(
      (kept) => kept || setChannel(was),
      (error: unknown) => {
        console.error(`update channel: ${String(error)}`);
        setChannel(was);
      },
    );
  };
  const busy = status?.state === "checking" || status?.state === "downloading";
  return (
    <SettingRow
      title="Update channel"
      description={statusLine(status)}
      control={
        <div className="flex items-center gap-2">
          {channel === null ? null : (
            <SegmentedControl<UpdateChannel>
              label="Update channel"
              options={CHANNELS}
              value={channel}
              onValueChange={change}
            />
          )}
          <Button size="sm" disabled={busy} onClick={() => void setting.check()}>
            Check now
          </Button>
        </div>
      }
    />
  );
}
