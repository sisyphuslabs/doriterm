import { Button, EmptyState, Notice } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { Monitor, Smartphone } from "lucide-react";
import { useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { desktopBridge, type DesktopBridge, type HostStartFailure } from "../desktop/bridge.ts";
import { startFailure, startThisComputer } from "../desktop/local-host.ts";
import { isIos, runsInstalled } from "../device/install.ts";
import { HostStartNotice } from "./host-start-notice.tsx";
import { JoinLanding } from "./join-landing.tsx";
import { PAIR_PATH } from "./link-capture.ts";
import { Steps } from "./steps.tsx";

const HOST_GUIDE = "https://github.com/sisyphuslabs/doriterm#readme";

/** Pairing reaches the relay, so offline it is shown, disabled, with why; nothing else here needs a network. */
const PAIR_NEEDS_NETWORK = "Pairing a host needs a network.";

function PairAHost({
  offline,
  primary,
  label = "Pair a host",
}: {
  readonly offline: boolean;
  readonly primary: boolean;
  readonly label?: string;
}) {
  if (offline) {
    return (
      <Button size="lg" disabled aria-describedby="pair-offline">
        {label}
      </Button>
    );
  }
  return (
    <Button variant={primary ? "primary" : undefined} size="lg" render={<Link to="/pair" />}>
      {label}
    </Button>
  );
}

function OfflineNotice() {
  return (
    <div id="pair-offline" className="w-full max-w-md">
      <Notice tone="warning" title="You are offline">
        {PAIR_NEEDS_NETWORK} The steps below work once it is back.
      </Notice>
    </div>
  );
}

/**
 * An installed app with no pairing. Its storage is a container of its own, so the host has never seen its device key
 * (#1404): on iOS a Home Screen web app never shares Safari's storage (Apple, WWDC23 "What's new in web apps"), and
 * elsewhere an installed app that was never paired is simply new. Either way it pairs once, and the person who already
 * uses Doriterm in Safari on this phone can open the offer from one of its terminals, with no trip to the computer.
 */
function InstalledFirstRun({ ios, offline }: { readonly ios: boolean; readonly offline: boolean }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-10">
      {offline ? <OfflineNotice /> : null}
      <Steps current={0} />
      <EmptyState
        icon={<Smartphone />}
        size="screen"
        title="Pair this app once"
        description={
          ios
            ? "A Home Screen app keeps its own storage, apart from Safari's, so your host sees it as a new device. It pairs once, and the pairing stays."
            : "An installed app is a device of its own, so your host sees it as a new device. It pairs once, and the pairing stays."
        }
        actions={
          <>
            <PairAHost offline={offline} primary label="Type the pairing code" />
            <Button variant="ghost" size="lg" render={<a href={HOST_GUIDE} target="_blank" rel="noreferrer" />}>
              How to start a host
            </Button>
          </>
        }
      >
        <p className="max-w-md text-sm text-pretty text-muted-foreground">
          {ios
            ? "Already paired in Safari on this phone? Open a terminal there and run the command below; then type the code it prints here."
            : "On your host, run the command below, or open Pair a device in the desktop app; then type the code here."}
        </p>
        <code className="rounded-md bg-raised px-3 py-2 text-sm text-foreground">doriface-host pair</code>
      </EmptyState>
    </main>
  );
}

function LocalFirstRun({ bridge, offline }: { readonly bridge: DesktopBridge; readonly offline: boolean }) {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<HostStartFailure | null>(null);
  // The notice stays up while a retry runs, so its Retry button shows the attempt instead of vanishing.
  const start = (): void => {
    setStarting(true);
    startThisComputer(bridge, connectionStore).catch((cause: unknown) => {
      setStarting(false);
      setFailure(startFailure(cause));
    });
  };
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-10">
      <EmptyState
        icon={<Monitor />}
        title="Use this computer or pair a host"
        description="Doriterm can run the terminals and agents on this computer, or show the ones on another computer you pair."
        actions={
          <>
            <Button variant="primary" size="lg" loading={starting} onClick={start}>
              Use this computer
            </Button>
            <PairAHost offline={offline} primary={false} />
          </>
        }
      />
      {offline ? (
        <p id="pair-offline" className="text-sm text-muted-foreground">
          {PAIR_NEEDS_NETWORK}
        </p>
      ) : null}
      {failure === null ? null : <HostStartNotice failure={failure} retrying={starting} onRetry={start} />}
    </main>
  );
}

/**
 * No host yet: in the desktop app, start one here (this computer needs no network, so being offline changes nothing);
 * elsewhere, the command that starts pairing, which does need a network, so an offline device says so above it.
 */
export function FirstRun({ offline = false }: { readonly offline?: boolean }) {
  const bridge = desktopBridge();
  if (bridge !== null) return <LocalFirstRun bridge={bridge} offline={offline} />;
  // An invite arrives as /pair#…, and JoinLanding is what reads it. An installed app that has one is joining, not
  // pairing for the first time, so the invitation has to reach JoinLanding instead of this screen.
  if (runsInstalled() && window.location.pathname !== PAIR_PATH)
    return <InstalledFirstRun ios={isIos()} offline={offline} />;
  return <JoinLanding />;
}
