import { expect, test } from "bun:test";
import { base64urlEncode, concatBytes } from "@doriface/crypto";

const holder = "a".repeat(26);
const mesh = "b".repeat(26);
const epoch = { epoch: 42, r_e: new Uint8Array(32).fill(34) };
const p0 = new Uint8Array(32).fill(17);
const fromHex = (hex: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(hex, "hex"));
const deviceInPlaintext = (opened: Uint8Array, device: Uint8Array): boolean =>
  Buffer.from(opened).includes(Buffer.from(device));

test("H1/H6/L1: fixed PRF salt and holder-specific lookup match the revision 6 HKDF", async () => {
  const { prfSalt, lookupFor } = await import("./keys.ts");
  expect(prfSalt()).toEqual(fromHex("a89b2ff8fc8bceb7692be1c6a4e6e94a96e76eb47133228ad8e16db0c53ca023"));
  expect(await lookupFor(p0, epoch, holder)).toBe(
    base64urlEncode(fromHex("d7797cea8cb122f8f65182e082803a2e2c2b0afcc4cab3821e6e0b58914692dd")),
  );
  expect(await lookupFor(p0, epoch, mesh)).not.toBe(await lookupFor(p0, epoch, holder));
  expect(await lookupFor(p0, { ...epoch, epoch: 43 }, holder)).not.toBe(await lookupFor(p0, epoch, holder));
  expect(await lookupFor(p0, { ...epoch, r_e: new Uint8Array(32) }, holder)).not.toBe(
    await lookupFor(p0, epoch, holder),
  );
});

test("M16/R1: in enrollment and after readmission, the actual plaintext contains only the card key", async () => {
  const { wrapCard, unwrapCard } = await import("./blobs.ts");
  const card = new Uint8Array(32).fill(51);
  const newCard = new Uint8Array(32).fill(68);
  const oldDevice = new Uint8Array(32).fill(85);
  const newDevice = new Uint8Array(32).fill(102);
  const base = { ...epoch, version: 3, meshId: mesh, hostId: holder };
  const next = { ...base, epoch: 43, r_e: new Uint8Array(32).fill(7), version: 4 };
  const blob = await wrapCard(p0, base, card);
  const rotated = await wrapCard(p0, next, newCard);
  const knownWrapKey = await crypto.subtle.importKey(
    "raw",
    fromHex("90d5b6b35b12df3e9b38914363c4f85df78dd0aafd4adec22553e51351d5fa80"),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const aad = concatBytes(fromHex("0000000000000003000000000000002a"), new TextEncoder().encode(`${mesh}${holder}`));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Uint8Array.from(blob.subarray(0, 12)), additionalData: Uint8Array.from(aad) },
    knownWrapKey,
    Uint8Array.from(blob.subarray(12)),
  );
  expect(new Uint8Array(plain)).toEqual(Uint8Array.from([...card, ...new Uint8Array(4096 - 28 - 32)]));
  expect(await unwrapCard(p0, base, blob)).toEqual(card);
  expect(await unwrapCard(p0, next, rotated)).toEqual(newCard);
  expect(deviceInPlaintext(new Uint8Array(plain), oldDevice)).toBe(false);
  expect(deviceInPlaintext(Uint8Array.from([...newCard, ...newDevice]), newDevice)).toBe(true);
  expect(deviceInPlaintext(await unwrapCard(p0, next, rotated), newDevice)).toBe(false);
  await expect(unwrapCard(p0, { ...next, r_e: epoch.r_e }, rotated)).rejects.toThrow();
});

test("H2/M5/L3: a holder, mesh, version or epoch substitution cannot open a capped blob", async () => {
  const { wrapCard, unwrapCard } = await import("./blobs.ts");
  const binding = { ...epoch, hostId: holder, meshId: mesh, version: 1 };
  const blob = await wrapCard(p0, binding, new Uint8Array(32));
  expect(blob.byteLength).toBe(4096);
  await Promise.all(
    [{ hostId: mesh }, { meshId: holder }, { version: 2 }, { epoch: 43 }].map((change) =>
      expect(unwrapCard(p0, { ...binding, ...change }, blob)).rejects.toThrow(),
    ),
  );
  await expect(unwrapCard(p0, binding, new Uint8Array(65_537))).rejects.toThrow();
});

test("S2: an authenticated locator contains only the single reviewed field list and fits eight holders", async () => {
  const { openLocator, sealLocator } = await import("./blobs.ts");
  const locator = {
    v: 1 as const,
    relayUrl: "https://relay.example.com",
    ...epoch,
    holders: Array.from("abcdefgh", (id) => ({ hostId: id.repeat(26), hostKey: base64urlEncode(p0) })),
  };
  const sealed = await sealLocator(p0, locator);
  expect(sealed.byteLength).toBeLessThan(1024);
  expect(await openLocator(p0, sealed)).toEqual(locator);
  await expect(openLocator(epoch.r_e, sealed)).rejects.toThrow();
});
