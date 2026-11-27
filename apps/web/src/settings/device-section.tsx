import { Button, SegmentedControl, SettingRow, Switch } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { desktopBackgroundSetting } from "../desktop/bridge.ts";
import { guideStore } from "../pair/first-run-guide.ts";
import { install, isIos, useInstallOffer } from "../device/install.ts";
import { keepAwakeStore, screenWakeLock, useKeepAwake } from "../device/keep-awake.ts";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { BackgroundRow } from "./background-row.tsx";
import { setEdgeProbe, useEdgeProbe } from "../pwa/edge-probe.ts";
import { keepStorage, useStorageKeeping } from "../storage/keep-storage.ts";
import { desktopUpdateSetting } from "../desktop/update-setting.ts";
import { UpdateChannelRow } from "./update-channel-row.tsx";
import type { DisplayMode } from "../terminal/prediction-display.ts";
import { predictionModeStore, usePredictionMode } from "../terminal/prediction-mode.ts";

const PREDICT_MODES = [
  { value: "adaptive", label: "On slow links" },
  { value: "always", label: "Always" },
  { value: "never", label: "Off" },
] as const;
import { BrowserInvite } from "./browser-invite.tsx";

/** Settings that belong to this browser or device rather than to an account: the screen, and installing the app. */
export function DeviceSection() {
  const keepAwake = useKeepAwake();
  const predictMode = usePredictionMode();
  const offer = useInstallOffer();
  const mesh = useBrowserMembership();
  const [background] = useState(() => desktopBackgroundSetting());
  const [updates] = useState(() => desktopUpdateSetting());
  const edgeProbe = useEdgeProbe();
  const keeping = useStorageKeeping();
  const [askedAgain, setAskedAgain] = useState(false);
  const rows = [
    // Where the browser may clear this app's storage (iOS can for a Home Screen app), its key and pairings go with it,
    // and the app starts unpaired; saying so here is what tells a person it was the phone, not a crash.
    keeping === "kept" ? (
      <SettingRow
        key="storage"
        title="Storage"
        description="Kept: the browser keeps this app's key and pairings."
        control={null}
      />
    ) : keeping === "best-effort" ? (
      <SettingRow
        key="storage"
        inline
        title="Storage"
        description={
          askedAgain
            ? "Still may be cleared: the browser decides this itself and kept its answer. If it clears this app's key and pairings, the app needs pairing again."
            : "May be cleared: the browser can remove this app's key and pairings, and it would then need pairing again."
        }
        control={
          askedAgain ? null : (
            <Button
              size="sm"
              onClick={() =>
                void keepStorage()
                  .finally(() => setAskedAgain(true))
                  .catch(() => undefined)
              }
            >
              Ask to keep
            </Button>
          )
        }
      />
    ) : null,
    background === null ? null : <BackgroundRow key="background" setting={background} />,
    updates === null ? null : <UpdateChannelRow key="update-channel" setting={updates} />,
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
    <SettingRow
      key="predict-typing"
      title="Show typing before the host echoes it"
      description="Draws what you type at once, underlined while the link is slow, and replaces it with the host's own text when it arrives."
      control={
        <SegmentedControl<DisplayMode>
          label="Show typing before the host echoes it"
          options={PREDICT_MODES}
          value={predictMode}
          onValueChange={(mode) => predictionModeStore.set(mode)}
        />
      }
    />,
    offer?.kind === "prompt" ? (
      <SettingRow
        key="install"
        inline
        title="Install Doriterm"
        description="Opens in its own window, from the Dock or the home screen."
        control={<Button onClick={() => void install(offer.prompt)}>Install</Button>}
      />
    ) : offer?.kind === "ios" && mesh.phase === "joined" ? (
      <BrowserInvite key="install" />
    ) : offer?.kind === "ios" ? (
      <SettingRow
        key="install"
        title="Add to Home Screen"
        description="In Safari, tap Share, then Add to Home Screen. Doriterm then opens in its own window and pairs once as a device of its own: iOS keeps a Home Screen app's storage apart from Safari's."
        control={null}
      />
    ) : null,
    // The top-edge readout (#2867), reachable from a Home Screen app, which has no address bar for ?edgeprobe=1. It
    // describes iOS's top-edge blur, so only an iPhone or iPad shows the row.
    !isIos() ? null : (
      <SettingRow
        key="edge-probe"
        inline
        title="Show the top-edge readout"
        description="A line at the bottom of the screen that says what iOS finds at the top edge, for a screenshot when the top of the app looks blurred."
        control={
          <Switch
            aria-label="Show the top-edge readout"
            checked={edgeProbe}
            onCheckedChange={(on) => setEdgeProbe(on)}
          />
        }
      />
    ),
    <SettingRow
      key="guide"
      inline
      title="Getting started"
      description="The first-run steps: start an agent and find it in the agents list."
      control={
        <Button render={<Link to="/" />} onClick={() => guideStore.start()}>
          Show again
        </Button>
      }
    />,
  ].filter((row) => row !== null);
  return <div className="flex flex-col">{rows}</div>;
}
