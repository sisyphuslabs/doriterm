import { type HostIdentity, rawStaticKey, SecureLinkError, secureLink, type SecureLinkOptions } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { socketFrom, testIp } from "../probe.ts";
import { within } from "../watch.ts";
import { identityOf } from "./identity.ts";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";
import { meshFileOf, type SignedRecord } from "./status.ts";

const encoder = new TextEncoder();
const ANSWER_MS = 20_000;
const JUDGED_MS = 60_000;

export type Outcome = "answered" | "closed" | "refused";

/** A sync session the harness opened; it stays open until `close`, so the target judges the batch on it. */
export interface Delivery {
  readonly kind: Outcome;
  /** The close code, for a refused or closed session. */
  readonly code: number | undefined;
  close(): void;
}

export interface DeliverOptions {
  readonly mesh: Mesh;
  /** The keys the session is opened with: a member's, or an outsider's for the refusal cases. */
  readonly carrier: HostIdentity;
  readonly target: MeshHost;
  readonly meshId: string;
  readonly records: readonly SignedRecord[];
}

const line = (value: object): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);

/**
 * Opens a mesh sync session to the target (`stream: "mesh"`, design section 10.2) and sends one batch: hello,
 * `records`, done. `answered` means the target served the session (its own `done` came back); it says nothing yet
 * about the records, which {@link untilJudged} waits for.
 */
export async function deliver(options: DeliverOptions): Promise<Delivery> {
  const { mesh, carrier, target, meshId, records } = options;
  const relay = mesh.relay;
  if (relay === undefined) throw new Error("deliver needs the local relay");
  const link = await connectRelayClient({
    relayUrl: relay.url,
    hostId: target.hostId,
    // Not a mesh host: its own address, so the relay's per-source lookup quota (3) is not the hosts' to share.
    createSocket: socketFrom(testIp()),
  });
  // `stream` is PR 3's handshake member; this branch's SecureLinkOptions does not declare it yet.
  const handshake: SecureLinkOptions & { readonly stream: "mesh" } = {
    role: "initiator",
    hostId: target.hostId,
    staticKey: rawStaticKey(carrier.noise),
    remoteStatic: identityOf(target).noise.publicKey,
    stream: "mesh",
  };
  const secure = await secureLink(link, handshake).catch((error: unknown) => {
    if (error instanceof SecureLinkError) return error;
    throw error;
  });
  if (secure instanceof SecureLinkError) return { kind: "refused", code: secure.code, close: () => undefined };
  const outcome = Promise.withResolvers<{ kind: Outcome; code: number | undefined }>();
  const decoder = new TextDecoder();
  secure.onData((bytes) => {
    if (decoder.decode(bytes).includes('"t":"done"')) outcome.resolve({ kind: "answered", code: undefined });
  });
  secure.onClose((error) => {
    outcome.resolve({ kind: "closed", code: error instanceof SecureLinkError ? error.code : undefined });
  });
  secure.send(line({ t: "hello", v: 2, mesh: meshId, heads: [], n: {} }));
  secure.send(line({ t: "records", records }));
  secure.send(line({ t: "done", mesh: meshId }));
  const settled = await within(outcome.promise, `${target.name}'s answer to the injected batch`, ANSWER_MS).catch(
    (error: unknown) => {
      secure.close();
      throw error;
    },
  );
  return { ...settled, close: () => secure.close() };
}

export type Judgement = "stored" | "dangling" | "refused";

/** How `host` has dealt with the record `hash`: stored in its set, held in the door's dangling pool, or refused (3.3). */
export function judgementOf(
  host: MeshHost,
  hash: string,
  hashOf: (record: SignedRecord) => string,
): Judgement | undefined {
  if (host.logs.some((entry) => entry.includes(`mesh: refused record ${hash}`))) return "refused";
  const file = meshFileOf(host);
  if (file.records.some((record) => hashOf(record) === hash)) return "stored";
  if (file.dangling.some((record) => hashOf(record) === hash)) return "dangling";
  return undefined;
}

/**
 * The sync point before any negative assertion: waits until `host` has judged every one of `hashes`, by the door's
 * refusal line (section 3.3) or by the hash appearing in `mesh.json`, and returns each judgement.
 */
export async function untilJudged(
  mesh: Mesh,
  host: MeshHost,
  hashes: readonly string[],
  hashOf: (record: SignedRecord) => string,
): Promise<ReadonlyMap<string, Judgement>> {
  const seen = new Map<string, Judgement>();
  await mesh.until(
    `${host.name} judges ${hashes.length} injected records`,
    () => {
      for (const hash of hashes) {
        const judged = seen.get(hash) ?? judgementOf(host, hash, hashOf);
        if (judged !== undefined) seen.set(hash, judged);
      }
      return seen.size === hashes.length;
    },
    JUDGED_MS,
  );
  return seen;
}
