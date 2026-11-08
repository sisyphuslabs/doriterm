import { Button, EmptyState } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { Monitor } from "lucide-react";
import { useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { desktopBridge, type DesktopBridge, type HostStartFailure } from "../desktop/bridge.ts";
import { startFailure, startThisComputer } from "../desktop/local-host.ts";
import { HostStartNotice } from "./host-start-notice.tsx";
import { JoinLanding } from "./join-landing.tsx";

/** Pairing reaches the relay, so offline it is shown, disabled, with why; nothing else here needs a network. */
const PAIR_NEEDS_NETWORK = "Pairing a host needs a network.";

function PairAHost({ offline, primary }: { readonly offline: boolean; readonly primary: boolean }) {
  if (offline) {
    return (
      <Button size="lg" disabled aria-describedby="pair-offline">
        Pair a host
      </Button>
    );
  }
  return (
    <Button variant={primary ? "primary" : undefined} size="lg" render={<Link to="/pair" />}>
      Pair a host
    </Button>
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
  return <JoinLanding />;
}
