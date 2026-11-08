import { base64urlDecode } from "@doriface/crypto";
import { expect, test } from "bun:test";
import { checkWelcome } from "../src/join/index.ts";
import { hashOf, signCard, signRecord } from "../src/records/codec.ts";
import { A, B, C, F, MESH, aB, admitOf, cardBody, noise } from "./fixtures/door-set.ts";

const identity = {
  hostId: C.hostId,
  sign: { publicKey: base64urlDecode(C.pub), secretKey: C.secret },
  noisePub: base64urlDecode(noise(3)),
};
const ctx = {
  identity,
  kind: "client" as const,
  own: { name: "browser", hcId: "", devicePub: noise(3) },
  dialed: { hostId: A.hostId, noisePub: base64urlDecode(noise(1)) },
  deadline: Date.now() + 60_000,
  adopt: () => true,
  log() {},
};
const offer = { t: "offer", mesh: MESH, inviter: A.pub, nonce: "nonce" } as const;
const clientCard = signCard(
  {
    ...cardBody(C, MESH, A.pub, 3, "browser"),
    v: 2,
    kind: "client",
    devicePub: noise(3),
    hcId: "",
  },
  C.secret,
);
const admitted = admitOf(clientCard, 3, [hashOf(aB)]);

test("a browser refuses a welcome that admits its signing key as a machine", () => {
  const machine = admitOf(signCard(cardBody(C, MESH, A.pub, 3), C.secret), 3, [hashOf(aB)]);
  expect(() => checkWelcome([F, aB, machine], offer, ctx)).toThrow("client");
});

test("a browser accepts its client card and a machine inviter with the pinned key", () => {
  expect(() => checkWelcome([F, aB, admitted], offer, ctx)).not.toThrow();
});

test("a client whose admitter left is refused even when another machine delivers the welcome", () => {
  const left = signRecord(
    {
      v: 2,
      mesh: MESH,
      type: "revoke",
      by: A.pub,
      n: 4,
      prev: [hashOf(admitted)],
      subject: { signPubs: [A.pub], reason: "leave" },
    },
    A.secret,
  );
  expect(() =>
    checkWelcome(
      [F, aB, admitted, left],
      { ...offer, inviter: B.pub },
      {
        ...ctx,
        dialed: { hostId: B.hostId, noisePub: base64urlDecode(noise(2)) },
      },
    ),
  ).toThrow("admitting machine");
});
