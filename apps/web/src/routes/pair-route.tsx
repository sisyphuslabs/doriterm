import { Button, EmptyState } from "@doriface/ui";
import { Link2Off } from "lucide-react";
import { useSyncExternalStore } from "react";
import { linkTarget, parsePairingFragment } from "../pair/fragment.ts";
import { pairingLink } from "../pair/link-capture.ts";
import { JoinLanding } from "../pair/join-landing.tsx";
import { MeshInvite } from "../pair/mesh-invite.tsx";
import { VerifyStep } from "../pair/verify-step.tsx";

/** With a captured link (already gone from the URL), verify the host; without, ask for the link or code. */
export function PairRoute() {
  const link = useSyncExternalStore(pairingLink.subscribe, pairingLink.get);
  if (link === null) return <JoinLanding />;
  const parsed = parsePairingFragment(link);
  if (parsed.ok && parsed.offer.target === "mesh") return <MeshInvite offer={parsed.offer} />;
  if (parsed.ok) return <VerifyStep key={link} offer={parsed.offer} />;
  // A broken link from `mesh pair` is fixed by a new mesh link, not by a device pairing (#727).
  const command = linkTarget(link) === "mesh" ? "doriface-host mesh pair" : "doriface-host pair";
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <EmptyState
        icon={<Link2Off />}
        title="This pairing link cannot be used"
        description={
          <>
            {parsed.reason} Run <code>{command}</code> again and open the new link.
          </>
        }
        actions={
          <Button variant="primary" size="lg" render={<a href="/pair" />}>
            Enter an invite
          </Button>
        }
      />
    </main>
  );
}
