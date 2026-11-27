import { base64urlDecode, hostIdOf } from "@doriface/crypto";
import {
  hashOf,
  memberCardOf,
  mergeAtDoor,
  meshIdOf,
  parseRecord,
  signBundleChallenge,
  type Signed,
  viewOf,
} from "@doriface/mesh";
import type { RestoreHolder, RestoreLocator } from "./blobs.ts";
import { lookupFor } from "./keys.ts";
import { anonymousRestore } from "./transport.ts";

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function signed(value: unknown): value is Signed {
  return object(value) && typeof value["body"] === "string" && typeof value["sig"] === "string";
}

export function currentHolders(
  records: readonly Signed[],
  candidates: readonly RestoreHolder[],
): readonly RestoreHolder[] {
  const view = viewOf(records);
  const byHash = new Map(records.map((record) => [hashOf(record), record]));
  return candidates.filter((candidate) =>
    [...view.members].some((key) => {
      const id = view.governing.get(key);
      const record = id === undefined ? undefined : byHash.get(id);
      const body = record === undefined ? undefined : parseRecord(record);
      const card = body === undefined ? undefined : memberCardOf(body);
      return (
        card !== undefined &&
        card.kind !== "client" &&
        card.hostId === candidate.hostId &&
        view.noise.get(key) === candidate.hostKey
      );
    }),
  );
}

export function holderSigningKey(records: readonly Signed[], member: RestoreHolder): string | undefined {
  return [...viewOf(records).members].find((key) => hostIdOf(base64urlDecode(key)) === member.hostId);
}

export async function verifiedRoster(
  p0: Uint8Array,
  locator: RestoreLocator,
  mesh: string,
  old: string,
  seed: Uint8Array,
): Promise<{ readonly records: readonly Signed[]; readonly responding: readonly RestoreHolder[] }> {
  const sets = await Promise.allSettled(
    locator.holders.map(async (holder) => {
      const lookup = await lookupFor(p0, locator, holder.hostId);
      const { json } = await anonymousRestore(locator.relayUrl, holder, (challenge) => ({
        t: "bundle",
        lookup,
        old,
        sig: signBundleChallenge(challenge, seed),
      }));
      if (
        !object(json) ||
        json["t"] !== "bundle" ||
        json["mesh"] !== mesh ||
        !Array.isArray(json["records"]) ||
        !json["records"].every(signed) ||
        json["records"].length === 0
      )
        return undefined;
      return { holder, records: json["records"] };
    }),
  );
  const received = sets.flatMap((result) =>
    result.status === "fulfilled" && result.value !== undefined ? [result.value] : [],
  );
  const merged = mergeAtDoor(
    [],
    [],
    received.flatMap(({ records }) => records),
  );
  const found = merged.stored.find((record) => parseRecord(record)?.type === "found");
  if (found === undefined || meshIdOf(found) !== mesh || !viewOf(merged.stored).members.has(old))
    throw new Error("This device is no longer a current mesh member. Ask for an invite.");
  return { records: merged.stored, responding: received.map(({ holder }) => holder) };
}
