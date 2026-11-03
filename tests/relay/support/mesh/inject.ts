import { type HostIdentity, rawStaticKey, SecureLinkError, secureLink, type SecureLinkOptions } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { socketFrom } from "../probe.ts";
import { within } from "../watch.ts";
import { identityOf } from "./identity.ts";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";
import type { SignedRecord } from "./status.ts";

const encoder = new TextEncoder();
const DONE_MS = 20_000;

export type Delivery =
  | { readonly kind: "answered" }
  | { readonly kind: "closed"; readonly code: number | undefined }
  | { readonly kind: "refused"; readonly code: number | undefined };

const line = (value: object): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);

/**
 * Opens a mesh sync session to `target` as the holder of `carrier`'s keys (a member's, for records that must arrive
 * through a member's session; an outsider's, for the refusal cases) and sends one batch: hello, `records`, done.
 * The handshake carries the `"mesh"` stream (design section 10.2). Resolves when the target answers `done` or closes.
 */
export async function deliver(
  mesh: Mesh,
  carrier: HostIdentity,
  target: MeshHost,
  meshId: string,
  records: readonly SignedRecord[],
): Promise<Delivery> {
  const relay = mesh.relay;
  if (relay === undefined) throw new Error("deliver needs the local relay");
  const link = await connectRelayClient({
    relayUrl: relay.url,
    hostId: target.hostId,
    createSocket: socketFrom(relay.ip),
  });
  const options: SecureLinkOptions & { readonly stream: "mesh" } = {
    role: "initiator",
    hostId: target.hostId,
    staticKey: rawStaticKey(carrier.noise),
    remoteStatic: identityOf(target).noise.publicKey,
    stream: "mesh",
  };
  const secure = await secureLink(link, options).catch((error: unknown) => {
    if (error instanceof SecureLinkError) return error;
    throw error;
  });
  if (secure instanceof SecureLinkError) return { kind: "refused", code: secure.code };
  const outcome = Promise.withResolvers<Delivery>();
  const decoder = new TextDecoder();
  secure.onData((bytes) => {
    if (decoder.decode(bytes).includes('"t":"done"')) outcome.resolve({ kind: "answered" });
  });
  secure.onClose((error) => {
    const code = error instanceof SecureLinkError ? error.code : undefined;
    outcome.resolve({ kind: "closed", code });
  });
  secure.send(line({ t: "hello", v: 2, mesh: meshId, heads: [], n: {} }));
  secure.send(line({ t: "records", records }));
  secure.send(line({ t: "done", mesh: meshId }));
  try {
    return await within(outcome.promise, `${target.name}'s answer to the injected batch`, DONE_MS);
  } finally {
    secure.close();
  }
}
