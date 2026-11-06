import type { HcConnection } from "@doriface/client";
import { Button, Dialog, Notice, Spinner } from "@doriface/ui";
import { useEffect, useRef, useState } from "react";
import { useJoinOffer } from "./join-command.ts";
import type { MachineEntry } from "./machines.ts";

const STEPS = [
  { where: "On the machine to add, start a pairing. It prints a link and a code.", command: "doriface-host pair" },
  {
    where: "On this machine, pair with it using that link.",
    command: "doriface-host connect '<link>' < /dev/null",
  },
  {
    where: "Still on this machine, add it under a name. Its terminals then show here.",
    command: "hc machine add --via 'doriface-host connect <hostId>' --name <name>",
  },
] as const;

const codeClass =
  "block rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-sm break-all whitespace-pre-wrap text-foreground select-all";

export interface AddMachineDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly connection: HcConnection;
  readonly machines: readonly MachineEntry[];
}

/** The first entry of `items` whose key was not there when watching started: the machine or member that just came. */
function useArrival<T>(items: readonly T[] | undefined, key: (item: T) => string, watching: boolean): T | undefined {
  const known = useRef<ReadonlySet<string> | null>(null);
  const [arrived, setArrived] = useState<T | undefined>(undefined);
  useEffect(() => {
    if (!watching) {
      known.current = null;
      setArrived(undefined);
      return;
    }
    if (items === undefined) return;
    known.current ??= new Set(items.map(key));
    const fresh = items.find((item) => !known.current?.has(key(item)));
    if (fresh !== undefined) setArrived((current) => current ?? fresh);
  }, [items, key, watching]);
  return arrived;
}

const coreOf = (machine: MachineEntry): string => machine.core;

/**
 * Adds a machine in one line (#668): this host opens a single-use mesh offer, and the dialog shows the command that
 * installs doriface-host on the other machine and joins this mesh; the cores then add each other as machines, and the
 * dialog says when the new one appears. The three hand-run steps stay below, under Advanced.
 */
export function AddMachineDialog({ open, onClose, connection, machines }: AddMachineDialogProps) {
  const offer = useJoinOffer(connection, open);
  const watching = open && (offer.phase === "ready" || offer.phase === "joined");
  const added = useArrival(
    machines.filter((machine) => !machine.local),
    coreOf,
    watching,
  );
  const [copied, setCopied] = useState(false);
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => setCopied(true));
  };
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
      <div className="flex flex-col gap-4">
        {offer.phase === "asking" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Asking this host for a join command…
          </p>
        ) : offer.phase === "ready" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-foreground">On the machine to add, run:</p>
            <code aria-label="Join command" className={codeClass}>
              {offer.command}
            </code>
            <div className="flex items-center gap-3">
              <Button variant="secondary" onClick={() => copy(offer.command)}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <span className="text-sm text-muted-foreground">It works once, for 10 minutes.</span>
            </div>
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Waiting for the machine to join…
            </p>
          </div>
        ) : offer.phase === "joined" ? (
          added === undefined ? (
            <Notice title={`${offer.name} joined this host's mesh`}>
              Its terminals show here once its host connects.
            </Notice>
          ) : (
            <Notice title={`Added ${added.name}`}>Its terminals show here.</Notice>
          )
        ) : offer.phase === "expired" ? (
          <Notice tone="warning" title="The command expired">
            Close this dialog and open it again for a new one.
          </Notice>
        ) : (
          <Notice tone="warning" title="No join command">
            {offer.reason}
          </Notice>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Advanced: pair and add by hand</summary>
          <ol className="mt-3 flex flex-col gap-4">
            {STEPS.map((step, index) => (
              <li key={step.command} className="flex flex-col gap-1.5">
                <p className="text-sm text-foreground">
                  <span data-numeric className="mr-1.5 text-muted-foreground">
                    {index + 1}.
                  </span>
                  {step.where}
                </p>
                <code className={codeClass}>{step.command}</code>
              </li>
            ))}
          </ol>
        </details>
      </div>
    </Dialog>
  );
}
