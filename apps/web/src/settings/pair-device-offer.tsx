import { Button, SettingRow } from "@doriface/ui";
import { Smartphone } from "lucide-react";
import { useMemo, useState } from "react";
import { desktopPairOffer } from "../desktop/pair-bridge.ts";
import { useConnectionSettings } from "../connection/store.ts";
import { PairDeviceDialog } from "./pair-device-dialog.tsx";

/**
 * Offers this computer to another device without a command line, on the screen a reader opens to pair one. It draws
 * nothing unless this app runs on its own host: the shell relays the offer, and a host this app merely reaches over the
 * relay runs somewhere else. Both This device and Connect a machine show it, so the desktop answer is never one
 * screen away from the question that led there (review of #772).
 */
export function PairDeviceOffer() {
  // Subscribed, so the offer follows a mode change on any screen that shows it, not only one whose parent subscribes.
  const settings = useConnectionSettings();
  // One relay function for this page: a new one each render would reopen the offer the dialog is showing.
  const pair = useMemo(() => desktopPairOffer(), []);
  const [pairing, setPairing] = useState(false);
  if (pair === null || settings.mode !== "loopback") return null;
  return (
    <>
      <SettingRow
        title={
          <span className="flex items-start gap-2 [&_svg:not([data-slot=spinner])]:size-4 [&_svg]:text-muted-foreground">
            <span className="flex h-[1lh] shrink-0 items-center">
              <Smartphone aria-hidden />
            </span>
            <span className="min-w-0">Pair a device</span>
          </span>
        }
        description="A phone or another computer that pairs with this computer can open its terminals, end to end encrypted."
        control={
          <Button size="sm" onClick={() => setPairing(true)}>
            Pair a device
          </Button>
        }
      />
      <PairDeviceDialog open={pairing} onClose={() => setPairing(false)} pair={pair} />
    </>
  );
}
