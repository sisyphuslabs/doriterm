import type { HcConnection } from "@doriface/client";
import { Button, Dialog, Notice, SettingRow, cn, fieldLabelClass } from "@doriface/ui";
import { useState } from "react";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { useMeshMembers } from "../connection/store.ts";
import { carryInvite } from "../pair/invite-handoff.ts";
import { useJoinOffer } from "../workspace/join-command.ts";
import { sortedMachines } from "./mesh-device.tsx";
import { LeaveMeshDialog } from "./membership-device.tsx";
import { MeshBody } from "./mesh-section.tsx";

export const onlineInviters = (entries: readonly MemberEntry[]) =>
  sortedMachines(entries).filter((entry) => entry.state.phase === "open");

export function InviteMachineChoice({
  entries,
  selected,
  onSelect,
}: {
  readonly entries: readonly MemberEntry[];
  readonly selected: string;
  readonly onSelect: (hostId: string) => void;
}) {
  const entry = entries.find((candidate) => candidate.target.hostId === selected);
  return (
    <div className="flex flex-col gap-2">
      <p>{`The invite is opened on ${entry?.target.hostName ?? selected}`}</p>
      <label className={cn("flex flex-col gap-1", fieldLabelClass)}>
        Machine that opens the invite
        <select
          className="h-(--control) rounded-md border border-border bg-background px-2 text-base text-foreground"
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
        >
          {entries.map(({ target }) => (
            <option key={target.hostId} value={target.hostId}>
              {target.hostName || target.hostId}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function InviteAnswer({ connection }: { readonly connection: HcConnection }) {
  const offer = useJoinOffer(connection, true, true);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const [keep, setKeep] = useState(false);
  const copy = async (link: string): Promise<void> => {
    try {
      await carryInvite(link);
      setCopied(true);
      setFailure(undefined);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  if (offer.phase === "asking") return <p role="status">Opening the invite…</p>;
  if (offer.phase === "failed")
    return (
      <Notice title="Could not open an invite" tone="error">
        {offer.reason}
      </Notice>
    );
  if (offer.phase === "expired") return <Notice title="This invite expired">Open another invite.</Notice>;
  if (offer.phase === "joined")
    return (
      <div className="flex flex-col gap-3">
        <p role="status">The home-screen app joined. Remove this tab from the mesh?</p>
        {!keep ? (
          <>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setLeaving(true)}>
                Remove
              </Button>
              <Button onClick={() => setKeep(true)}>Keep</Button>
            </div>
            <p className="text-prose text-muted-foreground">
              Keeping this tab leaves one more member key on this phone.
            </p>
            <LeaveMeshDialog open={leaving} close={() => setLeaving(false)} />
          </>
        ) : null}
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <Button render={<a href={offer.link} target="_blank" rel="noreferrer" />}>Open invite</Button>
      <Button onClick={() => void copy(offer.link)}>{copied ? "Copied invite" : "Copy invite"}</Button>
      {failure === undefined ? null : (
        <Notice title="Could not copy the invite" tone="error">
          {failure}
        </Notice>
      )}
      <p>
        Copy the invite, then in Safari tap Share and Add to Home Screen. Open the app and tap Paste invite. Switch back
        to Safari to compare and approve its code.
      </p>
      <MeshBody connection={connection} attentionOnly />
    </div>
  );
}

/** The home-screen app joins as its own member: Safari's tab opens the invite and approves it (#2939: the only use left). */
export function BrowserInvite() {
  const entries = useMeshMembers();
  const online = onlineInviters(entries);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const selected = online.find((entry) => entry.target.hostId === chosen) ?? online[0];
  const title = "Join in the home-screen app";
  return (
    <>
      <SettingRow
        title={title}
        description="The home-screen app joins as its own member, with its own keys."
        control={
          <Button disabled={online.length === 0} onClick={() => setOpen(true)}>
            {title}
          </Button>
        }
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description="A single-use invite, confirmed on both screens."
      >
        {open && selected !== undefined && selected.state.phase === "open" ? (
          <div className="flex flex-col gap-4">
            <InviteMachineChoice entries={online} selected={selected.target.hostId} onSelect={setChosen} />
            <InviteAnswer key={selected.target.hostId} connection={selected.state.connection} />
          </div>
        ) : (
          <p>No machine is online to open an invite.</p>
        )}
      </Dialog>
    </>
  );
}
