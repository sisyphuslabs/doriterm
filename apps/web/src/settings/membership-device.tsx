import { base64urlDecode } from "@doriface/crypto";
import type { HcConnection } from "@doriface/client";
import { Button, Dialog, Notice } from "@doriface/ui";
import { useState } from "react";
import { connectionStore, useMeshMembers } from "../connection/store.ts";
import { runsInstalled } from "../device/install.ts";
import { forgetMembership, useBrowserMembership } from "../mesh/membership-state.ts";
import { leaveMembership } from "../mesh/roster-refresh.ts";
import { useMesh } from "../mesh/use-mesh.ts";
import { fingerprintOf } from "../pair/fragment.ts";
import { MeshDevice, MeshMachineList, sortedMachines } from "./mesh-device.tsx";
import { useNavigate } from "@tanstack/react-router";
import { BrowserMemberList, RevokeCommand } from "./browser-members.tsx";
import { useNow } from "../workspace/use-now.ts";

export function RemovedMembership() {
  const [error, setError] = useState<string>();
  const again = async (): Promise<void> => {
    try {
      await forgetMembership();
      window.location.assign("/join");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="flex flex-col gap-4 p-6">
      <Notice title="This browser was removed from the mesh">
        Join again with an invite to make a new browser identity.
      </Notice>
      {error === undefined ? null : (
        <Notice tone="error" title="Could not clear this identity">
          {error}
        </Notice>
      )}
      <Button onClick={() => void again()}>Join again</Button>
    </div>
  );
}

export function LeaveMeshDialog({ open, close }: { readonly open: boolean; readonly close: () => void }) {
  const mesh = useBrowserMembership();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const leave = async (local: boolean): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    try {
      if (local) await forgetMembership();
      else await leaveMembership();
      window.location.assign("/join");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Leave this mesh"
      description="Remove this browser's membership and delete its keys from this device."
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void leave(false)}>
            Leave this mesh
          </Button>
        </>
      }
    >
      {failure === undefined ? null : (
        <div className="flex flex-col gap-3">
          <Notice title="Could not reach the mesh" tone="warning">
            {failure}
          </Notice>
          <p className="text-prose text-muted-foreground">
            The mesh still lists this browser until a member removes it.
          </p>
          <RevokeCommand name={mesh.self?.name ?? "browser"} />
          <Button onClick={() => void leave(true)}>Forget this mesh here</Button>
        </div>
      )}
    </Dialog>
  );
}

export function MembershipDeviceSection() {
  const mesh = useBrowserMembership();
  const entries = useMeshMembers();
  const [leaving, setLeaving] = useState(false);
  if (mesh.phase === "removed") return <RemovedMembership />;
  if (mesh.self === undefined) return null;
  return (
    <>
      <MeshDevice
        name={mesh.self.name}
        mesh={mesh.mesh}
        fingerprint={fingerprintOf(base64urlDecode(mesh.self.signPub))}
        installed={runsInstalled()}
        online={entries.filter((entry) => entry.state.phase === "open").length}
        onLeave={() => setLeaving(true)}
      />
      <LeaveMeshDialog open={leaving} close={() => setLeaving(false)} />
    </>
  );
}

export function MembershipMachines() {
  const mesh = useBrowserMembership();
  const entries = useMeshMembers();
  const navigate = useNavigate();
  const observer = sortedMachines(entries).find((entry) => entry.state.phase === "open");
  return (
    <div className="flex flex-col gap-6">
      <MeshMachineList
        entries={entries}
        ownComputer={undefined}
        retry={(hostId) => connectionStore.retry(hostId)}
        // Every machine is in the one workspace, whichever host carries the traffic (#2531): opening one only goes there.
        openMember={() => void navigate({ to: "/" })}
      />
      {observer?.state.phase === "open" ? (
        <ObservedBrowserMembers
          key={observer.target.hostId}
          connection={observer.state.connection}
          observer={observer.target.hostName}
        />
      ) : (
        <BrowserMemberList
          clients={mesh.clients}
          self={mesh.self?.signPub}
          observer={undefined}
          observations={undefined}
          now={Date.now()}
        />
      )}
    </div>
  );
}

function ObservedBrowserMembers({
  connection,
  observer,
}: {
  readonly connection: HcConnection;
  readonly observer: string;
}) {
  const mesh = useBrowserMembership();
  const { read } = useMesh(connection);
  const now = useNow();
  return (
    <BrowserMemberList
      clients={mesh.clients}
      self={mesh.self?.signPub}
      observer={observer}
      observations={read.phase === "ready" ? read.status.members : undefined}
      now={now}
    />
  );
}
