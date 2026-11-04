import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, describe, expect, test } from "bun:test";
import { ed25519Signer, generateSigningKey } from "./signer.ts";
import { Uplink } from "./uplink.ts";
import {
  decodeMux,
  decodePairSlotRequest,
  encodePairSlotAck,
  MuxType,
  PairSlotAckStatus,
  type PairSlotRequest,
  pairSlotStatement,
  SIGNED_PAIR_SLOT_BYTES,
} from "./wire/index.ts";

let relayTakesSignedForm = true;
const requests: { readonly length: number; readonly request: PairSlotRequest | undefined }[] = [];

const relay = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("upgrade", { status: 426 })),
  websocket: {
    open: (ws) => void ws.send(new Uint8Array(32)),
    message: (ws, message) => {
      if (typeof message === "string" || message.byteLength === 96) return;
      const frame = decodeMux(message);
      if (frame.type !== MuxType.PairSlot) return;
      const request = decodePairSlotRequest(frame.payload);
      requests.push({ length: frame.payload.byteLength, request });
      const refused = request === undefined || (request.signed !== undefined && !relayTakesSignedForm);
      ws.send(encodePairSlotAck("AB3", refused ? PairSlotAckStatus.Malformed : PairSlotAckStatus.Registered));
    },
  },
});
afterAll(() => relay.stop(true));

async function answeredUplink(secretKey: Uint8Array): Promise<Uplink> {
  const answered = Promise.withResolvers<void>();
  const uplink = await Uplink.start({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    signer: ed25519Signer(secretKey),
    credit: false,
    onSession: () => {},
    onState: (state) => {
      if (state.state === "answered") answered.resolve();
    },
  });
  await answered.promise;
  return uplink;
}

describe("registering a pairing slot", () => {
  test("the host signs its slot, Noise key and offer expiry with its signing key", async () => {
    relayTakesSignedForm = true;
    requests.length = 0;
    const secretKey = generateSigningKey();
    const uplink = await answeredUplink(secretKey);
    const noiseStaticPub = crypto.getRandomValues(new Uint8Array(32));
    const expiresAt = Date.now() + 600_000;
    expect(await uplink.registerPairSlot("AB3", noiseStaticPub, expiresAt)).toBe("registered");
    const [sent] = requests;
    expect(sent?.length).toBe(SIGNED_PAIR_SLOT_BYTES);
    expect(sent?.request?.signed?.expiresAt).toBe(expiresAt);
    const signature = sent?.request?.signed?.signature ?? new Uint8Array(64);
    const statement = pairSlotStatement("AB3", noiseStaticPub, expiresAt);
    expect(ed25519.verify(signature, statement, ed25519Signer(secretKey).publicKey)).toBe(true);
    uplink.stop();
  });

  test("a relay that acks the signed form malformed (v1.7) gets the unsigned form, and the result says so", async () => {
    relayTakesSignedForm = false;
    requests.length = 0;
    const uplink = await answeredUplink(generateSigningKey());
    const outcome = await uplink.registerPairSlot("AB3", new Uint8Array(32).fill(4), Date.now() + 600_000);
    expect(outcome).toBe("registered-unsigned");
    expect(requests.map(({ length }) => length)).toEqual([SIGNED_PAIR_SLOT_BYTES, 35]);
    uplink.stop();
  });
});
