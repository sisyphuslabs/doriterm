import { base64urlEncode, generateHostIdentity, rawStaticKey } from "@doriface/crypto";
import { mergeAtDoor, readmitCode, signReadmit, type ReadmitSubject, type Signed, viewOf } from "@doriface/mesh";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { BrowserIdentity } from "../mesh/identity.ts";
import { DEFAULT_SLOT, slotKeys } from "../mesh/identity-slots.ts";
import { MembershipStore } from "../mesh/membership.ts";
import { deviceStore } from "../storage/idb.ts";
import { openLocator, type RestoreHolder, type RestoreLocator, unwrapCard } from "./blobs.ts";
import { writeRestore } from "./enrollment.ts";
import { lookupFor } from "./keys.ts";
import type { Passkey } from "./passkey.ts";
import { currentHolders, holderSigningKey, object, signed, verifiedRoster } from "./roster.ts";
import { anonymousRestore } from "./transport.ts";

export interface PreparedRestore {
  readonly code: string;
  attempt(): Promise<"waiting" | "restored" | "restore-off">;
  discard(): void;
}

async function recoverCard(
  p0: Uint8Array,
  locator: RestoreLocator,
): Promise<{ readonly mesh: string; readonly seed: Uint8Array }> {
  return Promise.any(
    locator.holders.map(async (holder) => {
      const lookup = await lookupFor(p0, locator, holder.hostId);
      const { json, data } = await anonymousRestore(locator.relayUrl, holder, () => ({ t: "fetch", lookup }));
      if (
        !object(json) ||
        json["t"] !== "blob" ||
        json["epoch"] !== locator.epoch ||
        typeof json["mesh"] !== "string" ||
        typeof json["version"] !== "number"
      )
        throw new Error("no restore blob");
      const seed = await unwrapCard(
        p0,
        { ...locator, hostId: holder.hostId, meshId: json["mesh"], version: json["version"] },
        data,
      );
      return { mesh: json["mesh"], seed };
    }),
  ).catch(() => {
    throw new Error("No current holder could open this passkey’s restore data. Ask a member for an invite.");
  });
}

export async function prepareRestore(passkey: Passkey, name: string): Promise<PreparedRestore> {
  const { credential, p0, bytes } = await passkey.read();
  let locator: RestoreLocator | undefined;
  try {
    locator = await openLocator(p0, bytes);
    const { mesh, seed } = await recoverCard(p0, locator);
    try {
      const old = base64urlEncode(ed25519.getPublicKey(seed));
      const { records, responding } = await verifiedRoster(p0, locator, mesh, old, seed);
      const holders = currentHolders(records, locator.holders);
      const holder = holders.find((candidate) => responding.includes(candidate));
      if (holder === undefined) throw new Error("No saved holder is still a member. Ask for an invite.");
      const fresh = generateHostIdentity();
      const fields = {
        old,
        signPub: base64urlEncode(fresh.sign.publicKey),
        noise: base64urlEncode(fresh.noise.publicKey),
        name: viewOf(records).name.get(old) ?? name,
        nonce: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
        at: Date.now(),
      };
      const proof: ReadmitSubject = {
        ...fields,
        newSig: signReadmit(mesh, fields, fresh.sign.secretKey),
        oldSig: signReadmit(mesh, fields, seed),
      };
      return ready(passkey, credential, p0, locator, holder, holders, records, mesh, fresh, proof);
    } finally {
      seed.fill(0);
    }
  } catch (error) {
    p0.fill(0);
    locator?.r_e.fill(0);
    throw error;
  }
}

function ready(
  passkey: Passkey,
  credential: Parameters<Passkey["write"]>[0],
  p0: Uint8Array,
  locator: RestoreLocator,
  holder: RestoreHolder,
  holders: readonly RestoreHolder[],
  records: readonly Signed[],
  mesh: string,
  fresh: ReturnType<typeof generateHostIdentity>,
  proof: ReadmitSubject,
): PreparedRestore {
  const { relayUrl } = locator;
  const discard = (): void => {
    fresh.sign.secretKey.fill(0);
    fresh.noise.secretKey.fill(0);
    p0.fill(0);
    locator.r_e.fill(0);
  };
  return {
    code: readmitCode(mesh, proof),
    discard,
    async attempt() {
      const lookup = await lookupFor(p0, locator, holder.hostId);
      const { json } = await anonymousRestore(relayUrl, holder, () => ({ t: "readmit", lookup, proof }));
      if (object(json) && json["t"] === "waiting") return "waiting";
      if (!object(json) || json["t"] !== "admitted" || !signed(json["record"]))
        throw new Error("The member was not readmitted. Ask a member for an invite.");
      const verified = mergeAtDoor(records, [], [json["record"]]);
      const view = viewOf(verified.stored);
      if (
        !view.members.has(proof.signPub) ||
        view.members.has(proof.old) ||
        view.noise.get(proof.signPub) !== proof.noise
      )
        throw new Error("The new device was not admitted by the verified roster. Ask a member for an invite.");
      const inviter = holderSigningKey(verified.stored, holder);
      if (inviter === undefined) throw new Error("The holder left the mesh during readmission.");
      await install(verified.stored, { ...holder, mesh, inviter }, relayUrl, fresh, proof);
      const identity: BrowserIdentity = {
        device: rawStaticKey(fresh.noise),
        card: {
          publicKey: fresh.sign.publicKey,
          kind: "raw",
          sign: async (bytes) => ed25519.sign(bytes, fresh.sign.secretKey),
        },
      };
      try {
        await writeRestore(
          passkey,
          credential,
          p0,
          locator.epoch + 1,
          { relayUrl, meshId: mesh, holders },
          identity,
          fresh.sign.secretKey,
        );
        await deviceStore.put(`restore-enabled:${DEFAULT_SLOT}`, true);
        return "restored";
      } catch {
        await deviceStore.put(`restore-enabled:${DEFAULT_SLOT}`, false);
        return "restore-off";
      } finally {
        discard();
      }
    },
  };
}

async function install(
  records: readonly Signed[],
  source: Parameters<MembershipStore["accept"]>[1],
  relayUrl: string,
  fresh: ReturnType<typeof generateHostIdentity>,
  proof: ReadmitSubject,
): Promise<void> {
  const bundle = new MembershipStore(deviceStore, { signPub: proof.signPub, devicePub: proof.noise }, DEFAULT_SLOT);
  await bundle.enroll();
  const keys = slotKeys(deviceStore, DEFAULT_SLOT);
  await keys.put("device-key", { kind: "raw", privateKey: fresh.noise.secretKey });
  await keys.put("mesh-sign-key", { kind: "raw", privateKey: fresh.sign.secretKey });
  await bundle.accept(records, source, relayUrl);
}
