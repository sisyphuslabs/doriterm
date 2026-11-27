import { base64urlEncode, bytesEqual } from "@doriface/crypto";
import type { MemberTarget } from "../connection/settings.ts";
import type { BrowserIdentity } from "../mesh/identity.ts";
import { lookupFor } from "./keys.ts";
import { type RestoreLocator, sealLocator, wrapCard } from "./blobs.ts";
import type { Passkey } from "./passkey.ts";
import { anonymousRestore, restoreOwner } from "./transport.ts";

export interface EnrollmentTarget {
  readonly relayUrl: string;
  readonly meshId: string;
  readonly holders: readonly Pick<MemberTarget, "hostId" | "hostKey">[];
}

export async function enrollRestore(
  passkey: Passkey,
  target: EnrollmentTarget,
  identity: BrowserIdentity,
  raw: Uint8Array,
): Promise<void> {
  if (target.holders.length < 2) throw new Error("Two current machines must be available to set up passkey restore.");
  const { credential, p0 } = await passkey.create(Date.now());
  try {
    await writeRestore(passkey, credential, p0, 1, target, identity, raw);
  } catch (error) {
    await passkey.retire(credential);
    throw error;
  } finally {
    p0.fill(0);
  }
}

export async function removeRestore(target: EnrollmentTarget, identity: BrowserIdentity): Promise<void> {
  const replies = await Promise.allSettled(
    target.holders.map((holder) => restoreOwner(target.relayUrl, holder, identity, { t: "remove" })),
  );
  if (replies.some((reply) => reply.status === "rejected" || reply.value !== true))
    throw new Error("Some machines did not confirm removal. Bring them online and try again.");
}

/** Assertion 2 happens after admission. A declined assertion creates no blobs for the new identity. */
export async function writeRestore(
  passkey: Passkey,
  credential: Parameters<Passkey["write"]>[0],
  p0: Uint8Array,
  epoch: number,
  target: EnrollmentTarget,
  identity: BrowserIdentity,
  cardSeed: Uint8Array,
): Promise<void> {
  const { relayUrl, meshId } = target;
  const holders = target.holders.slice(0, 8).map(({ hostId, hostKey }) => ({ hostId, hostKey }));
  if (holders.length < 2) throw new Error("Two current machines are needed to keep passkey restore on.");
  const r_e = crypto.getRandomValues(new Uint8Array(32));
  const locator: RestoreLocator = { v: 1, relayUrl, epoch, r_e, holders };
  const version = Date.now();
  try {
    await passkey.write(credential, await sealLocator(p0, locator));
    const replies = await Promise.allSettled(
      holders.map(async (holder) => {
        const lookup = await lookupFor(p0, locator, holder.hostId);
        const blob = await wrapCard(p0, { epoch, r_e, meshId, hostId: holder.hostId, version }, cardSeed);
        if (
          (await restoreOwner(relayUrl, holder, identity, {
            t: "put",
            lookup,
            version,
            epoch,
            blob: base64urlEncode(blob),
          })) !== true
        )
          return false;
        // Do not promise recovery on a relay that has not enabled the distinct, source-budgeted route.
        const reply = await anonymousRestore(relayUrl, holder, () => ({ t: "fetch", lookup }));
        return bytesEqual(reply.data, blob);
      }),
    );
    if (replies.some((result) => result.status === "rejected" || result.value !== true)) {
      await removeRestore(target, identity);
      throw new Error("Not every holder accepted the restore key.");
    }
  } finally {
    r_e.fill(0);
  }
}
