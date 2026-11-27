import { expect, test } from "bun:test";
import { generateX25519, x25519FromSecret } from "../identity.ts";
import { rawStaticKey } from "../static-key.ts";

test("M7/S5: NK authenticates only the holder, encrypts the lookup, and decrypts one transport reply", async () => {
  const { openRestoreNoise, answerRestoreNoise } = await import("./restore-nk.ts");
  const host = rawStaticKey(x25519FromSecret(new Uint8Array(32).fill(2)));
  const request = new TextEncoder().encode("a holder-specific lookup that must not occur on the relay wire");
  const client = openRestoreNoise(host.publicKey, x25519FromSecret(new Uint8Array(32).fill(3)));
  const nonce = new Uint8Array(32).fill(4);
  const holder = await answerRestoreNoise(host, client.first, nonce);
  const received = client.finish(holder.second);
  expect(received.challenge).toEqual(nonce);
  const frame = received.send.encryptWithAd(new Uint8Array(), request);
  expect(Buffer.from(frame).includes(request)).toBe(false);
  expect(holder.receive.decryptWithAd(new Uint8Array(), frame)).toEqual(request);
  const reply = holder.send.encryptWithAd(new Uint8Array(), nonce);
  expect(received.receive.decryptWithAd(new Uint8Array(), reply)).toEqual(nonce);
  expect(() => client.finish(holder.second)).toThrow();
});

test("M7: a holder with a different static key cannot authenticate the pre-admission channel", async () => {
  const { openRestoreNoise, answerRestoreNoise } = await import("./restore-nk.ts");
  const host = generateX25519();
  const client = openRestoreNoise(host.publicKey);
  await expect(answerRestoreNoise(rawStaticKey(generateX25519()), client.first, new Uint8Array(32))).rejects.toThrow();
});
