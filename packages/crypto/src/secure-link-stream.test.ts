import { describe, expect, test } from "bun:test";
import { concatBytes } from "./encoding.ts";
import { generateX25519, prologueFor } from "./identity.ts";
import { SessionKind } from "./kinds.ts";
import { CloseCode } from "./link.ts";
import { Handshake } from "./noise/handshake.ts";
import { generateLinkSecret } from "./pairing.ts";
import { linkPairingPsk } from "./pairing-keys.ts";
import { type ClientHello, secureLink } from "./secure-link.ts";
import { rawStaticKey } from "./static-key.ts";
import { memoryLinkPair } from "./testing/memory-link.ts";
import { device, host, settledError } from "./testing/secure-link-fixture.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A responder that records every hello it is asked about, and a hand-built message 1 with `payload`. */
async function sendRaw(kind: SessionKind, payload: string) {
  const [clientEnd, hostEnd] = memoryLinkPair();
  const asked: ClientHello[] = [];
  const linkSecret = generateLinkSecret();
  const responder = secureLink(hostEnd, {
    role: "responder",
    hostId: host.hostId,
    staticKey: rawStaticKey(host.noise),
    authorize: (hello) => {
      asked.push(hello);
      return { accept: true, secret: { mode: "link", linkSecret } };
    },
  });
  const pairing = kind === SessionKind.PairLink;
  const handshake = new Handshake({
    pattern: pairing ? "IKpsk2" : "IK",
    role: "initiator",
    prologue: prologueFor(host.hostId, kind),
    staticKey: rawStaticKey(device),
    remoteStatic: host.noise.publicKey,
    ...(pairing ? { psk: linkPairingPsk(linkSecret, host.hostId, host.noise.publicKey) } : {}),
  });
  clientEnd.send(concatBytes(Uint8Array.of(kind), await handshake.writeMessage(utf8(payload))));
  return { responder, asked, hostEnd };
}

describe("the stream member of message 1 (contract v1.5)", () => {
  test.each([
    ["the mesh stream with early bytes", SessionKind.Session, '{"v":1,"stream":"mesh"}\nearly'],
    ['"hc" on a link pairing', SessionKind.PairLink, '{"v":1,"name":"laptop","stream":"hc"}\n'],
    ["an unknown stream on a session", SessionKind.Session, '{"v":1,"stream":"files"}\n'],
    ["a join whose mesh name breaks herdr's rule", SessionKind.PairLink, '{"v":1,"name":"My Mac","stream":"mesh"}\n'],
  ])("%s closes 4400 before the host is asked to authorize", async (_, kind, payload) => {
    const { responder, asked, hostEnd } = await sendRaw(kind, payload);
    expect((await settledError(responder)).code).toBe(CloseCode.CryptoFailure);
    expect(hostEnd.closeCode).toBe(CloseCode.CryptoFailure);
    expect(asked).toEqual([]);
  });

  test("the stream reaches authorize and both ends of the session", async () => {
    const [clientEnd, hostEnd] = memoryLinkPair();
    const asked: ClientHello[] = [];
    const responder = secureLink(hostEnd, {
      role: "responder",
      hostId: host.hostId,
      staticKey: rawStaticKey(host.noise),
      authorize: (hello) => {
        asked.push(hello);
        return { accept: true };
      },
    });
    const initiator = secureLink(clientEnd, {
      role: "initiator",
      hostId: host.hostId,
      staticKey: rawStaticKey(generateX25519()),
      remoteStatic: host.noise.publicKey,
      stream: "mesh",
    });
    const [client, server] = await Promise.all([initiator, responder]);
    expect(asked.map((hello) => hello.stream)).toEqual(["mesh"]);
    expect([client.stream, server.stream]).toEqual(["mesh", "mesh"]);
  });
});
