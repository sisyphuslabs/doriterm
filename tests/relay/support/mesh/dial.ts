import { type HostIdentity, rawStaticKey, SecureLinkError, secureLink } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { socketFrom } from "../probe.ts";
import { identityOf } from "./identity.ts";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";

export type Dialed =
  | { readonly kind: "open"; close(): void }
  | { readonly kind: "refused"; readonly code: number | undefined };

/**
 * A client session to `target` through the relay, as the holder of `who`'s Noise key, from the mesh's one source IP.
 * A refusal at the handshake comes back as its close code; nothing is read after it.
 */
export async function dialAs(mesh: Mesh, who: HostIdentity, target: MeshHost): Promise<Dialed> {
  const relay = mesh.relay;
  if (relay === undefined) throw new Error("dialAs needs the local relay");
  const link = await connectRelayClient({
    relayUrl: relay.url,
    hostId: target.hostId,
    createSocket: socketFrom(relay.ip),
  });
  try {
    const secure = await secureLink(link, {
      role: "initiator",
      hostId: target.hostId,
      staticKey: rawStaticKey(who.noise),
      remoteStatic: identityOf(target).noise.publicKey,
    });
    return { kind: "open", close: () => secure.close() };
  } catch (error) {
    if (error instanceof SecureLinkError) return { kind: "refused", code: error.code };
    throw error;
  }
}
