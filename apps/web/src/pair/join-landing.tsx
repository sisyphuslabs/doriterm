import { Button, Notice } from "@doriface/ui";
import { useEffect, useState } from "react";
import type { PairingOffer } from "./fragment.ts";
import { JoinEntry } from "./join-entry.tsx";
import { loadJoinAnchor } from "./join-anchor.ts";
import { MeshInvite } from "./mesh-invite.tsx";
import { VerifyStep } from "./verify-step.tsx";

export function JoinLanding() {
  const [offer, setOffer] = useState<PairingOffer>();
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void loadJoinAnchor().then(
      (anchor) => {
        if (live) setResuming(anchor !== undefined);
        return undefined;
      },
      (cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
        return undefined;
      },
    );
    return () => {
      live = false;
    };
  }, []);
  if (error !== undefined)
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-6 py-10">
        <Notice title="Not joined">{error}</Notice>
        <Button onClick={() => setError(undefined)}>Join again</Button>
      </main>
    );
  if (resuming) return <MeshInvite />;
  if (offer !== undefined) return offer.target === "mesh" ? <MeshInvite offer={offer} /> : <VerifyStep offer={offer} />;
  return <JoinEntry onOffer={setOffer} />;
}
