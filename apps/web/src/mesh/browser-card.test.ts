import { base64urlEncode } from "@doriface/crypto";
import { verifyCard } from "@doriface/mesh";
import { expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { browserCard } from "./browser-card.ts";
import { clientIdOf, loadBrowserIdentity } from "./identity.ts";

test("join and roster cards retain the browser foundation's stable client id", async () => {
  const identity = await loadBrowserIdentity(memoryStore(), null);
  const signed = await browserCard(identity, "browser", {
    t: "offer",
    mesh: "mesh",
    nonce: base64urlEncode(new Uint8Array(16)),
    inviter: base64urlEncode(new Uint8Array(32)),
  });
  const card = verifyCard(signed);
  expect(card?.hcId).toBe(clientIdOf(identity.card.publicKey));
  expect(card?.kind).toBe("client");
  expect(card?.devicePub).toBe(base64urlEncode(identity.device.publicKey));
  expect(card?.noisePub).toBe(card?.devicePub);
});
