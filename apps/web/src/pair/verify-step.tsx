import { Button, Fingerprint, Notice } from "@doriface/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { connectionStore } from "../connection/store.ts";
import { deviceName } from "./device-name.ts";
import type { OfferSecret, PairingOffer } from "./fragment.ts";
import { pairAndOpen } from "./handshake.ts";
import { guideStore } from "./first-run-guide.ts";
import { Steps } from "./steps.tsx";

type Outcome =
  | { readonly kind: "pending" }
  | { readonly kind: "pairing" }
  | { readonly kind: "paired" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "rejected" };

/** What a key mismatch means: a typed code may have reached another host, a link may not come from yours. */
export const MISMATCH: Readonly<Record<OfferSecret["mode"], string>> = {
  code: "The key differs from the one your host printed, so this code may have reached another host. Run doriface-host pair again and type the new code.",
  link: "The key differs from the one your host printed, so this link may not come from it. Run doriface-host pair again and use the new link.",
};

/** The person compares the host key with what the host printed; only a match runs the pairing handshake. */
export function VerifyStep({ offer }: { readonly offer: PairingOffer }) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: "pending" });
  const match = async (): Promise<void> => {
    setOutcome({ kind: "pairing" });
    try {
      await pairAndOpen(offer, deviceName(), connectionStore);
    } catch (error) {
      setOutcome({ kind: "failed", reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    guideStore.start();
    setOutcome({ kind: "paired" });
  };
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-5 px-6 py-10">
      <Steps current={2} />
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-balance text-foreground">Check the host's key</h1>
        <p className="mt-1.5 text-base text-muted-foreground">
          The host prints the same groups when you run{" "}
          <code className="text-foreground">doriface-host fingerprint</code>.
        </p>
      </div>
      <div className="rounded-lg bg-raised p-4">
        <Fingerprint label="Host key (SHA-256)" value={offer.fingerprint.replaceAll(" ", "")} />
      </div>
      <Result
        mode={offer.secret.mode}
        outcome={outcome}
        onMatch={() => void match()}
        onReject={() => setOutcome({ kind: "rejected" })}
      />
    </main>
  );
}

function Result({
  mode,
  outcome,
  onMatch,
  onReject,
}: {
  readonly mode: OfferSecret["mode"];
  readonly outcome: Outcome;
  readonly onMatch: () => void;
  readonly onReject: () => void;
}) {
  switch (outcome.kind) {
    case "pending":
    case "pairing":
      return (
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" loading={outcome.kind === "pairing"} onClick={onMatch}>
            They match
          </Button>
          <Button variant="ghost" size="lg" disabled={outcome.kind === "pairing"} onClick={onReject}>
            They don't match
          </Button>
        </div>
      );
    case "paired":
      return (
        <>
          <Notice title="Paired">This device now reaches the host through the relay, end to end encrypted.</Notice>
          <Button variant="primary" size="lg" render={<Link to="/" />}>
            Open terminals
          </Button>
        </>
      );
    case "failed":
      return (
        <>
          <Notice tone="error" title="Pairing did not finish">
            {outcome.reason}
          </Notice>
          <Button variant="secondary" size="lg" render={<a href="/pair" />}>
            Try again
          </Button>
        </>
      );
    case "rejected":
      return (
        <>
          <Notice tone="error" title="Do not pair with this host">
            {MISMATCH[mode]}
          </Notice>
          <Button variant="secondary" size="lg" render={<Link to="/" />}>
            Back
          </Button>
        </>
      );
  }
}
