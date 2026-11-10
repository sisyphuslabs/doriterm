import { Button, Dialog, Field, Fingerprint, Input, Notice, QrCode } from "@doriface/ui";
import { useEffect, useMemo, useState } from "react";
import { desktopPairOffer, type DesktopPairAnswer } from "../desktop/pair-bridge.ts";
import { qrModules } from "../pair/qr.ts";
import { useNow } from "../workspace/use-now.ts";
import {
  expiryLine,
  linkOpens,
  offerCode,
  pairDeviceView,
  qrLink,
  slotNote,
  type PairDeviceView,
} from "./pair-device.ts";

/** How often the dialog asks the host what stands while an offer is live. */
const POLL_MS = 1_000;

export interface PairDeviceDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The shell's pairing offer; undefined asks the desktop bridge, null means this build has none. */
  readonly pair?: ((request: "open" | "state") => Promise<DesktopPairAnswer>) | null;
}

/**
 * Offers this computer to another device: the host's code, QR code, link, fingerprint and expiry, then the device that
 * used it. Every answer comes from the shell, which asks the running doriface-host over its token-guarded loopback.
 */
export function PairDeviceDialog({ open, onClose, pair }: PairDeviceDialogProps) {
  const ask = useMemo(() => (pair === undefined ? desktopPairOffer() : pair), [pair]);
  const [answer, setAnswer] = useState<DesktopPairAnswer | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const now = useNow(POLL_MS);
  const view: PairDeviceView =
    ask === null
      ? { kind: "unavailable", reason: "This build has no way to ask this computer's host for an offer." }
      : pairDeviceView(answer, now);
  const scanned = view.kind === "offer" ? qrLink(view.offer) : null;
  const modules = useMemo(() => (scanned === null ? null : qrModules(scanned)), [scanned]);

  useEffect(() => {
    if (!open || ask === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (request: "open" | "state"): Promise<void> => {
      if (cancelled) return;
      try {
        const next = await ask(request);
        if (cancelled) return;
        setAnswer(next);
        setBusy(false);
        if (next.state === "pending" && Date.now() < next.offer.expiresAt) {
          timer = setTimeout(() => void poll("state"), POLL_MS);
        }
      } catch (error) {
        if (cancelled) return;
        setBusy(false);
        setAnswer({ state: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      }
    };
    setBusy(true);
    void poll("open");
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [open, ask, round]);

  const again = (): void => {
    setCopied(false);
    setAnswer(null);
    setRound((value) => value + 1);
  };

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Pair a device"
      description="The device you pair reaches this computer's terminals through the relay, end to end encrypted."
      className="w-[min(30rem,calc(100%-2rem))]"
      actions={actionsFor(view.kind, { onClose, again, busy })}
    >
      {view.kind === "asking" ? (
        <p className="text-prose text-muted-foreground">Asking this computer's host for a code…</p>
      ) : view.kind === "offer" ? (
        <div className="flex flex-col gap-4">
          {modules === null ? null : (
            <QrCode
              modules={modules}
              label="QR code for this computer's pairing link"
              className="mx-auto w-44 border border-border p-1"
            />
          )}
          <p data-pair-code className="text-center font-mono text-2xl tracking-[0.25em] text-foreground">
            {offerCode(view.offer)}
          </p>
          <Field label="Pairing link" htmlFor="pair-link" hint={linkOpens(view.offer.opens)}>
            <div className="flex items-start gap-2">
              <Input
                id="pair-link"
                mono
                readOnly
                value={view.offer.link}
                className="text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button variant="secondary" onClick={() => void copy(view.offer.link)}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Field>
          <div className="rounded-lg bg-raised p-4">
            <Fingerprint label="This computer's key (SHA-256)" value={view.offer.fingerprint.replaceAll(" ", "")} />
            <p className="mt-2 text-prose text-pretty text-muted-foreground">
              The other device shows the same groups before it pairs.
            </p>
          </div>
          {slotNote(view.offer) === undefined ? null : (
            <p className="text-prose text-pretty text-muted-foreground">{slotNote(view.offer)}</p>
          )}
          <p className="text-prose text-muted-foreground">{expiryLine(view.offer, now)}</p>
        </div>
      ) : view.kind === "paired" ? (
        view.device === null ? (
          <Notice title="Paired" tone="info">
            The device can open this computer's terminals now.
          </Notice>
        ) : (
          <Notice title={`Paired with ${view.device.name}`} tone="info">
            Device {view.device.id}. It can open this computer's terminals now.
          </Notice>
        )
      ) : view.kind === "expired" ? (
        <Notice tone="warning" title="This offer has expired">
          Open a new one to pair a device.
        </Notice>
      ) : (
        <Notice tone="error" title="This computer's host did not answer">
          {view.reason}
        </Notice>
      )}
    </Dialog>
  );
}

function actionsFor(
  kind: ReturnType<typeof pairDeviceView>["kind"],
  { onClose, again, busy }: { readonly onClose: () => void; readonly again: () => void; readonly busy: boolean },
) {
  const done = (
    <Button variant="primary" onClick={onClose}>
      Done
    </Button>
  );
  if (kind === "offer" || kind === "paired") {
    return (
      <>
        <Button variant="secondary" loading={busy} onClick={again}>
          {kind === "paired" ? "Pair another device" : "New code"}
        </Button>
        {done}
      </>
    );
  }
  if (kind === "expired" || kind === "unavailable") {
    return (
      <>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        <Button variant="primary" loading={busy} onClick={again}>
          Try again
        </Button>
      </>
    );
  }
  return done;
}
