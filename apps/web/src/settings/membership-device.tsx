import { base64urlDecode } from "@doriface/crypto";
import { meshRevokeCommand } from "@doriface/protocol";
import { Button, Dialog, Notice, SettingRow } from "@doriface/ui";
import { useState } from "react";
import { connectionStore, useMeshMembers } from "../connection/store.ts";
import { standalone } from "../device/install.ts";
import { forgetMembership, useBrowserMembership } from "../mesh/browser-membership.ts";
import { leaveMembership } from "../mesh/roster-refresh.ts";
import { Command } from "../mesh/mesh-rows.tsx";
import { fingerprintOf } from "../pair/fragment.ts";
import { MeshDevice, MeshMachineList } from "./mesh-device.tsx";

function RevokeCommand({ name }: { readonly name: string }) {
  const command = meshRevokeCommand(name);
  return command === undefined ? null : <Command command={command} label={`Copy the command that removes ${name}`} />;
}

export function RemovedMembership() {
  const [error, setError] = useState<string>();
  const again = async (): Promise<void> => {
    try {
      await forgetMembership();
      window.location.assign("/join");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <div className="flex flex-col gap-4 p-6">
      <Notice title="This browser was removed from the mesh">Join again with an invite to make a new browser identity.</Notice>
      {error === undefined ? null : <Notice tone="error" title="Could not clear this identity">{error}</Notice>}
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
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}
      title="Leave this mesh" description="Remove this browser's membership and delete its keys from this device."
      actions={<><Button variant="ghost" onClick={close}>Cancel</Button><Button loading={busy} onClick={() => void leave(false)}>Leave this mesh</Button></>}>
      {failure === undefined ? null : (
        <div className="flex flex-col gap-3">
          <Notice title="Could not reach the mesh" tone="warning">{failure}</Notice>
          <p className="text-sm text-muted-foreground">The mesh still lists this browser until a member removes it.</p>
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
      <MeshDevice name={mesh.self.name} mesh={mesh.mesh} fingerprint={fingerprintOf(base64urlDecode(mesh.self.signPub))}
        installed={standalone()} online={entries.filter((entry) => entry.state.phase === "open").length}
        onLeave={() => setLeaving(true)} />
      <LeaveMeshDialog open={leaving} close={() => setLeaving(false)} />
    </>
  );
}

export function MembershipMachines() {
  const mesh = useBrowserMembership();
  const entries = useMeshMembers();
  return (
    <div className="flex flex-col gap-6">
      <MeshMachineList entries={entries} ownComputer={undefined} retry={(hostId) => connectionStore.retry(hostId)} />
      <section aria-labelledby="browser-members">
        <h3 id="browser-members" className="text-lg font-semibold">Browsers and phones</h3>
        {mesh.clients.map((client) => (
          <SettingRow key={client.signPub} title={`${client.name}${client.signPub === mesh.self?.signPub ? " (this browser)" : ""}`}
            description={<RevokeCommand name={client.name} />} control={null} />
        ))}
      </section>
    </div>
  );
}
