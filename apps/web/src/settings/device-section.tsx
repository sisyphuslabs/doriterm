import { Button, SettingRow, Switch } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { desktopBackgroundSetting } from "../desktop/bridge.ts";
import { guideStore } from "../pair/first-run-guide.ts";
import { install, useInstallOffer } from "../device/install.ts";
import { keepAwakeStore, screenWakeLock, useKeepAwake } from "../device/keep-awake.ts";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { BackgroundRow } from "./background-row.tsx";
import { BrowserInvite } from "./browser-invite.tsx";

/** Settings that belong to this browser or device rather than to an account: the screen, and installing the app. */
export function DeviceSection() {
  const keepAwake = useKeepAwake();
  const offer = useInstallOffer();
  const mesh = useBrowserMembership();
  const [background] = useState(() => desktopBackgroundSetting());
  const rows = [
    background === null ? null : <BackgroundRow key="background" setting={background} />,
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
        title="Install Doriterm"
        description="Opens in its own window, from the Dock or the home screen."
        control={
          <Button size="sm" onClick={() => void install(offer.prompt)}>
            Install
          </Button>
        }
      />
    ) : offer?.kind === "ios" && mesh.phase === "joined" ? (
      <BrowserInvite key="install" install />
    ) : offer?.kind === "ios" ? (
      <SettingRow
        key="install"
        title="Add to Home Screen"
        description="In Safari, tap Share, then Add to Home Screen. Doriterm then opens in its own window and pairs once as a device of its own: iOS keeps a Home Screen app's storage apart from Safari's."
        control={null}
      />
    ) : null,
    <SettingRow
      key="guide"
      inline
      title="Getting started"
      description="The first-run steps: start an agent and find it in the agents list."
      control={
        <Button size="sm" render={<Link to="/" />} onClick={() => guideStore.start()}>
          Show again
        </Button>
      }
    />,
  ].filter((row) => row !== null);
  return <div className="flex flex-col">{rows}</div>;
}
