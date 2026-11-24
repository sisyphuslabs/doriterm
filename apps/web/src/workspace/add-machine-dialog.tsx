import type { HcConnection } from "@doriface/client";
import { Button, Dialog } from "@doriface/ui";
import { InviteField } from "../pair/invite-field.tsx";
import { JoinCommandBlock } from "./join-command-block.tsx";
import type { MachineEntry } from "./machines.ts";

export interface AddMachineDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly connection: HcConnection;
  readonly machines: readonly MachineEntry[];
}

/**
 * Adds a machine in one line (#668) or joins another machine's mesh from its invite (#2795): this host opens a
 * single-use mesh offer above, and the invite field below hands off to `/pair` when the user already has an invite.
 */
export function AddMachineDialog({ open, onClose, connection, machines }: AddMachineDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Add a machine"
      description="Run one command on the machine to add. It installs doriface-host and herdr-core if they are missing, runs the host as a service, and joins this host's mesh through the relay, end to end encrypted, with no ssh or open port."
      className="w-[min(36rem,calc(100%-2rem))]"
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <JoinCommandBlock connection={connection} open={open} machines={machines} />
        <section aria-labelledby="add-machine-invite" className="flex flex-col gap-3 border-t border-border pt-4">
          <h3 id="add-machine-invite" className="font-semibold text-foreground">
            Have an invite from another machine?
          </h3>
          <InviteField />
        </section>
      </div>
    </Dialog>
  );
}
