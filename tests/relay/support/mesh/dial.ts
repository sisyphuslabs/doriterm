import { type HostIdentity, rawStaticKey, SecureLinkError, secureLink, type SecureLinkOptions } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { socketFrom } from "../probe.ts";
import { identityOf } from "./identity.ts";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";

export type Stream = "hc" | "mesh";

export type Dialed =
  | {
      readonly kind: "open";
      /** Resolves with the close code once the target (or the relay) ends the session. */
      readonly closed: Promise<number | undefined>;
      /** Plaintext bytes the target sent on the session so far. */
      received(): number;
      close(): void;
    }
  | { readonly kind: "refused"; readonly code: number | undefined };

/**
 * A client session to `target` through the relay, as the holder of `who`'s Noise key, from the mesh's one source IP,
 * on the hc stream (an hc hello's session) or the mesh stream. A refusal at the handshake comes back as its close code.
 */
export async function dialAs(mesh: Mesh, who: HostIdentity, target: MeshHost, stream: Stream = "hc"): Promise<Dialed> {
  const relay = mesh.relay;
  if (relay === undefined) throw new Error("dialAs needs the local relay");
  const link = await connectRelayClient({
    relayUrl: relay.url,
    hostId: target.hostId,
    createSocket: socketFrom(relay.ip),
  });
  // `stream` is PR 3's handshake member; this branch's SecureLinkOptions does not declare it yet.
  const options: SecureLinkOptions & { readonly stream?: "mesh" } = {
    role: "initiator",
    hostId: target.hostId,
    staticKey: rawStaticKey(who.noise),
    remoteStatic: identityOf(target).noise.publicKey,
    ...(stream === "mesh" ? { stream } : {}),
  };
  try {
    const secure = await secureLink(link, options);
    let received = 0;
    secure.onData((bytes) => {
      received += bytes.byteLength;
    });
    const closed = new Promise<number | undefined>((resolve) => {
      secure.onClose((error) => resolve(error instanceof SecureLinkError ? error.code : undefined));
    });
    return { kind: "open", closed, received: () => received, close: () => secure.close() };
  } catch (error) {
    if (error instanceof SecureLinkError) return { kind: "refused", code: error.code };
    throw error;
  }
}

/** The close code of each dial: a refusal's, or "open" when the target let the session up. */
export const refusalCodes = (dialed: readonly Dialed[]): readonly (number | string | undefined)[] =>
  dialed.map((each) => {
    if (each.kind === "refused") return each.code;
    each.close();
    return "open";
  });
