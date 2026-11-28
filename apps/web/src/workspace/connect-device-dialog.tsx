import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";
import { Button, Dialog, Notice, QrCode, SegmentedControl, Spinner } from "@doriface/ui";
import { useMemo, useState } from "react";
import { useConnectionSettings } from "../connection/store.ts";
import { desktopPairOffer } from "../desktop/pair-bridge.ts";
import { InviteField } from "../pair/invite-field.tsx";
import { qrModules } from "../pair/qr.ts";
import { AgentInvite } from "../settings/agent-invite.tsx";
import { JoinCommandBlock } from "./join-command-block.tsx";
import { useJoinOffer, webInviteLink } from "./join-command.ts";
import type { MachineEntry } from "./machines.ts";
import { useMachines } from "./use-machines.ts";
import { useWidthTier } from "../layout/width-tier.ts";

const NO_TERMINALS: readonly Terminal[] = [];

export type ConnectDeviceTab = "phone" | "computer" | "agent";

export interface ConnectDeviceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly connection: HcConnection;
  readonly machines: readonly MachineEntry[];
}

/**
 * On a phone the sheet rises from the bottom edge and covers down to the safe area, scrolling inside itself, so no line
 * of the page under it shows below its edge (#2949 review, the agent tab's 390 review).
 */
const SHEET_CLASS =
  "top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 rounded-b-none border-x-0 border-b-0 max-h-[calc(100dvh-var(--safe-top,0px)-1rem)] pb-[calc(var(--safe-bottom,0px)+1.25rem)]";

const KINDS = [
  { value: "phone", label: "Phone or browser" },
  { value: "computer", label: "Computer" },
  { value: "agent", label: "AI agent" },
] as const;

/** A phone or browser joins with a link it opens (or a QR it scans), then waits for the owner's approval. */
function PhoneInvite({ connection, open }: { readonly connection: HcConnection; readonly open: boolean }) {
  const offer = useJoinOffer(connection, open, true);
  const [copied, setCopied] = useState(false);
  const link = offer.phase === "ready" ? webInviteLink(offer.link) : null;
  const modules = useMemo(() => (link === null ? null : qrModules(link)), [link]);
  if (offer.phase === "asking")
    return (
      <p role="status" className="flex items-center gap-2 text-prose text-muted-foreground">
        <Spinner /> Opening an invite…
      </p>
    );
  if (offer.phase === "failed")
    return (
      <Notice tone="warning" title="Could not open an invite">
        {offer.reason}
      </Notice>
    );
  if (offer.phase === "expired")
    return (
      <Notice tone="warning" title="The invite expired">
        Close this and open it again for a new one.
      </Notice>
    );
  if (offer.phase === "joined") return <Notice title={`${offer.name} joined`}>It reaches your terminals now.</Notice>;
  if (link === null || modules === null) return null;
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <QrCode
        modules={modules}
        label="Invite QR code"
        className="w-36 shrink-0 self-center border border-border p-1 sm:self-start"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="text-prose text-foreground">Scan it, or open this link on the phone or in the browser.</p>
        <code
          aria-label="Invite link"
          className="block truncate rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-sm select-all"
        >
          {link}
        </code>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <span className="text-prose text-muted-foreground">Works once, for 10 minutes.</span>
        </div>
        <p className="text-prose text-muted-foreground">
          It asks to join, with a code to compare. You approve it here or on any of your devices.
        </p>
      </div>
    </div>
  );
}

/**
 * The one place to connect anything to this mesh (#2939): a phone or browser joins with an invite link and the
 * owner's approval; a computer joins with one command (#668) or from an invite it already holds (#2795).
 */
export function ConnectDeviceDialog({ open, onClose, connection, machines }: ConnectDeviceDialogProps) {
  const [shown, setShown] = useState<ConnectDeviceTab>("phone");
  const compact = useWidthTier() === "compact";
  const settings = useConnectionSettings();
  const pair = useMemo(() => desktopPairOffer(), []);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Connect a device"
      description="One invite for a phone, a browser, a computer or an AI agent. A phone or browser waits for your approval."
      className={compact ? SHEET_CLASS : "w-[min(36rem,calc(100%-2rem))]"}
      actions={<Button onClick={onClose}>Done</Button>}
    >
      <div className="flex flex-col gap-5">
        <SegmentedControl label="What to connect" options={KINDS} value={shown} onValueChange={setShown} />
        {shown === "phone" ? (
          <PhoneInvite connection={connection} open={open} />
        ) : shown === "computer" ? (
          <>
            <p className="max-w-measure text-prose text-muted-foreground">
              One command installs doriface-host and herdr-core if they are missing, runs the host as a service, and
              joins this mesh through the relay, end to end encrypted, with no ssh or open port.
            </p>
            <JoinCommandBlock connection={connection} open={open} machines={machines} />
            <section aria-labelledby="connect-invite" className="flex flex-col gap-3 border-t border-border pt-4">
              <h3 id="connect-invite" className="font-semibold text-foreground">
                Have an invite from another machine?
              </h3>
              <InviteField />
            </section>
          </>
        ) : pair !== null && settings.mode === "loopback" ? (
          <AgentInvite pair={pair} open={open} />
        ) : (
          <p className="text-prose text-pretty text-muted-foreground">
            Open Doriterm on the computer your agent runs on, then come back to this tab there.
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** The sheet for a caller that has the connection but not its machine list (Settings, the join page). */
export function ConnectDeviceSheet({
  connection,
  onClose,
}: {
  readonly connection: HcConnection;
  readonly onClose: () => void;
}) {
  const { entries } = useMachines(connection, NO_TERMINALS);
  return <ConnectDeviceDialog open onClose={onClose} connection={connection} machines={entries} />;
}
