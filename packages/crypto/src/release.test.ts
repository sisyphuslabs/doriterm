import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { parseReleaseSecret, releasePublicKey, signRelease, verifyRelease } from "./release.ts";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const oldKey = ed25519.utils.randomSecretKey();
const newKey = ed25519.utils.randomSecretKey();
const sums = utf8("4ddfab64  doriface-host-linux-x64\n");

test("a signature verifies under its own key and under none other", () => {
  const signature = signRelease(sums, oldKey);
  expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
  expect(verifyRelease(sums, signature, [releasePublicKey(oldKey)])).toBe(true);
  expect(verifyRelease(sums, signature, [releasePublicKey(newKey)])).toBe(false);
  expect(verifyRelease(sums, signature, [])).toBe(false);
});

test("a changed byte, a truncated or garbled signature, or a malformed key is refused", () => {
  const signature = signRelease(sums, oldKey);
  const trusted = [releasePublicKey(oldKey)];
  const tampered = sums.slice();
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  expect(verifyRelease(tampered, signature, trusted)).toBe(false);
  expect(verifyRelease(sums, signature.slice(0, 40), trusted)).toBe(false);
  expect(verifyRelease(sums, "not base64!", trusted)).toBe(false);
  expect(verifyRelease(sums, signature, ["AAAA", "", "x".repeat(44)])).toBe(false);
});

test("during a rotation a build that trusts both keys accepts either signature", () => {
  const both = [releasePublicKey(oldKey), releasePublicKey(newKey)];
  expect(verifyRelease(sums, signRelease(sums, oldKey), both)).toBe(true);
  expect(verifyRelease(sums, signRelease(sums, newKey), both)).toBe(true);
});

test("the signing secret is base64 of a 32-byte seed", () => {
  expect(parseReleaseSecret(`${oldKey.toBase64()}\n`)).toEqual(oldKey);
  expect(() => parseReleaseSecret("c2hvcnQ=")).toThrow("32 bytes");
});
