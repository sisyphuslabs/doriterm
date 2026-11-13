import { Button, DelayedSpinner, EmptyState, Notice } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { PlugZap } from "lucide-react";
import { hostFailure } from "../connection/host-failure.ts";
import { staysOnThisComputer } from "../connection/settings.ts";
import { connectionStore, useConnection } from "../connection/store.ts";
import { desktopBridge, type HostStartFailure } from "../desktop/bridge.ts";
import { startFailure, startThisComputer } from "../desktop/local-host.ts";
import { FirstRun } from "../pair/first-run.tsx";
import { HostStartNotice } from "../pair/host-start-notice.tsx";
import { useOnline } from "../pwa/use-online.ts";
import { QuietBusy } from "../terminal/quiet-busy.tsx";
import { lazy, Suspense, useState } from "react";
import { restoreMembership, useBrowserMembership, useMembershipFailure } from "../mesh/membership-state.ts";
import { RemovedMembership } from "../settings/membership-device.tsx";

const Workspace = lazy(() => import("../workspace/workspace.tsx").then((module) => ({ default: module.Workspace })));

/** This computer's host did not start at launch: why, with Retry to start it again and Settings to choose another. */
function HostStartFailed({ failure }: { readonly failure: HostStartFailure }) {
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    const bridge = desktopBridge();
    if (bridge === null) return;
    setRetrying(true);
    startThisComputer(bridge, connectionStore).catch((cause: unknown) => {
      setRetrying(false);
      connectionStore.hostStartFailed(startFailure(cause));
    });
  };
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <HostStartNotice failure={failure} retrying={retrying} onRetry={retry} settings />
    </main>
  );
}

/** The workspace once connected (and while it reconnects); otherwise what is happening and the next step. */
export function WorkspaceRoute() {
  const state = useConnection();
  const online = useOnline();
  const mesh = useBrowserMembership();
  const membershipFailure = useMembershipFailure();
  if (membershipFailure !== undefined)
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6">
        <Notice title="Could not read this browser's membership" tone="error">
          {membershipFailure}
        </Notice>
        <Button onClick={() => void restoreMembership()}>Try again</Button>
      </main>
    );
  if (mesh.phase === "removed" && state.phase !== "open") return <RemovedMembership />;
  // A link to this computer needs no network, so a lost network is never its cause (as in reconnect-status.tsx).
  const offline = !online && !staysOnThisComputer(connectionStore.settings);
  const shown =
    state.phase === "open"
      ? state.connection
      : state.phase === "connecting" || state.phase === "failed"
        ? state.stale
        : null;
  if (shown !== null) {
    return (
      <Suspense
        fallback={
          <QuietBusy label="Loading the workspace" text="Loading the workspace…" className="h-dvh bg-background" />
        }
      >
        <Workspace connection={shown} />
      </Suspense>
    );
  }

  if (state.phase === "host-failed") return <HostStartFailed failure={state.failure} />;
  // Nothing chosen yet: always the first-run steps, so being offline is never a dead end (#216).
  if (state.phase === "unconfigured") return <FirstRun offline={!online} />;
  const settings = (
    <Button render={<Link to="/settings" />} variant="secondary">
      Open settings
    </Button>
  );
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="flex w-full max-w-md flex-col gap-4">
        {offline ? (
          <Notice tone="warning" title="You are offline">
            The app works offline, but reaching your host needs a network.
          </Notice>
        ) : null}
        {state.phase === "connecting" ? (
          <EmptyState
            // The spinner keeps its one size (it is never resized per site); the slot around it is the failed screen's icon
            // box (size-8), so turning to "Cannot reach your host" keeps the title still (#1961).
            icon={
              <span data-slot="icon-box" className="flex size-8 items-center justify-center">
                <DelayedSpinner />
              </span>
            }
            title="Connecting to your host"
            description="Opening the session."
          />
        ) : state.phase === "failed" ? (
          <EmptyState
            icon={<PlugZap aria-hidden className="size-5" />}
            title="Cannot reach your host"
            description={
              state.retryInMs === null
                ? hostFailure(state.error)
                : `${hostFailure(state.error)} Trying again in ${Math.round(state.retryInMs / 1000)} s.`
            }
            actions={
              state.retryInMs === null ? (
                settings
              ) : (
                <>
                  <Button variant="primary" onClick={() => connectionStore.start()}>
                    Try now
                  </Button>
                  {settings}
                </>
              )
            }
          />
        ) : null}
      </div>
    </main>
  );
}
