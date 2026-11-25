import { describe, expect, test } from "bun:test";
import { toBase64 } from "typevault/core";
import { EMPTY_VAULT, mergeVaults, parseVaultDoc, type VaultDoc } from "./doc.ts";
import { maintain, readEntry, resolveVault, writeEntry } from "./vault.ts";
import { signRecord, wrapDigest } from "./records.ts";
import { contextOf, MESH, NOW, testDevice } from "./testing.ts";

const SONIOX = "soniox";
const fields = (key: string) => ({ $default: { type: "secret", value: key } }) as const;

describe("a two-device mesh", () => {
  test("a device wrapped by another opens the entry with its own key and no password", async () => {
    const [laptop, phone] = [await testDevice(), await testDevice()];
    const members = [laptop, phone];
    let doc = await maintain(EMPTY_VAULT, contextOf(laptop, members));
    doc = await writeEntry(doc, contextOf(laptop, members), SONIOX, fields("sk-1"));
    expect((await readEntry(doc, contextOf(phone, members), SONIOX)).kind).toBe("locked");

    doc = await maintain(doc, contextOf(phone, members));
    doc = await maintain(doc, contextOf(laptop, members));
    const read = await readEntry(doc, contextOf(phone, members), SONIOX);
    expect(read.kind === "open" && read.payload.fields["$default"]).toEqual({ type: "secret", value: "sk-1" });
  });

  test("the document carries no plaintext secret", async () => {
    const laptop = await testDevice();
    let doc = await maintain(EMPTY_VAULT, contextOf(laptop, [laptop]));
    doc = await writeEntry(doc, contextOf(laptop, [laptop]), SONIOX, fields("sk-plaintext-marker"));
    expect(JSON.stringify(doc)).not.toContain("sk-plaintext-marker");
    expect(JSON.stringify(doc)).not.toContain(SONIOX);
  });
});

describe("records from outside the current membership", () => {
  test("a non-member's device announcement gets no wrap", async () => {
    const [laptop, stranger] = [await testDevice(), await testDevice()];
    let doc = await maintain(EMPTY_VAULT, contextOf(laptop, [laptop]));
    doc = await maintain(doc, contextOf(stranger, [laptop, stranger]));
    doc = await maintain(doc, contextOf(laptop, [laptop]));
    expect(resolveVault(doc, contextOf(laptop, [laptop])).devices.has(stranger.signPub)).toBe(false);
    expect(Object.values(doc.wraps).some((wraps) => stranger.signPub in wraps)).toBe(false);
  });

  test("a member-signed wrap that opens to a key other than the signed tier key is ignored", async () => {
    const [laptop, phone] = [await testDevice(), await testDevice()];
    const members = [laptop, phone];
    let doc = await maintain(EMPTY_VAULT, contextOf(laptop, members));
    doc = await writeEntry(doc, contextOf(laptop, members), SONIOX, fields("sk-1"));
    doc = await maintain(doc, contextOf(phone, members));
    const tier = resolveVault(doc, contextOf(phone, members)).tier;
    if (tier === undefined) throw new Error("expected a tier");
    const planted = await laptop.key.generate(tier.gen);
    const wrap = toBase64(await planted.wrapFor(phone.deviceKey.recipient));
    const body = {
      v: 1,
      type: "vault-wrap",
      mesh: MESH,
      tier: tier.id,
      holder: phone.signPub,
      recipient: phone.deviceKey.recipient,
      digest: wrapDigest(wrap),
      by: laptop.signPub,
      at: NOW,
    } as const;
    const signed = { ...(await signRecord(body, laptop.signer)), wrap };
    const tampered: VaultDoc = {
      ...doc,
      wraps: { ...doc.wraps, [tier.id]: { [phone.signPub]: { [laptop.signPub]: signed } } },
    };
    expect((await readEntry(tampered, contextOf(phone, members), SONIOX)).kind).toBe("locked");
    expect(planted.publicKey).not.toEqual(tier.publicKey);
  });
});

describe("rollback", () => {
  test("an older revision handed over after a newer one was seen is refused", async () => {
    const laptop = await testDevice();
    const ctx = contextOf(laptop, [laptop]);
    let doc = await maintain(EMPTY_VAULT, ctx);
    const first = await writeEntry(doc, ctx, SONIOX, fields("sk-1"));
    doc = await writeEntry(first, ctx, SONIOX, fields("sk-2"));
    const latest = await readEntry(doc, ctx, SONIOX);
    expect(latest.kind === "open" && latest.rev).toBe(2);
    expect((await readEntry(first, ctx, SONIOX)).kind).toBe("rolled-back");
  });

  test("a stale copy from before a rotation does not make the device start a new vault over it", async () => {
    const [laptop, lost] = [await testDevice(), await testDevice()];
    let stale = await maintain(EMPTY_VAULT, contextOf(laptop, [laptop, lost]));
    stale = await maintain(stale, contextOf(lost, [laptop, lost]));
    stale = await maintain(stale, contextOf(laptop, [laptop, lost]));
    stale = await writeEntry(stale, contextOf(laptop, [laptop, lost]), SONIOX, fields("sk-1"));
    const rotated = await maintain(stale, contextOf(laptop, [laptop]));
    expect(resolveVault(rotated, contextOf(laptop, [laptop])).tier?.gen).toBe(2);

    const kept = await maintain(stale, contextOf(laptop, [laptop]));
    expect(kept.tiers).toEqual(stale.tiers);
    expect(kept.entries).toEqual(stale.entries);
  });
});

describe("revoking a member", () => {
  test("rotates to a new generation the revoked device cannot open, and flags the secret for replacement", async () => {
    const [laptop, phone, lost] = [await testDevice(), await testDevice(), await testDevice()];
    const all = [laptop, phone, lost];
    let doc = await maintain(EMPTY_VAULT, contextOf(laptop, all));
    doc = await maintain(doc, contextOf(phone, all));
    doc = await maintain(doc, contextOf(lost, all));
    doc = await maintain(doc, contextOf(laptop, all));
    doc = await writeEntry(doc, contextOf(laptop, all), SONIOX, fields("sk-1"));
    const before = resolveVault(doc, contextOf(laptop, all)).tier?.gen;

    const remaining = [laptop, phone];
    doc = await maintain(doc, contextOf(laptop, remaining));
    const after = resolveVault(doc, contextOf(laptop, remaining)).tier;
    expect(after?.gen).toBe((before ?? 0) + 1);
    expect(after === undefined ? undefined : doc.wraps[after.id]?.[lost.signPub]).toBeUndefined();

    const phoneRead = await readEntry(doc, contextOf(phone, remaining), SONIOX);
    expect(phoneRead.kind === "open" && phoneRead.payload.needsRotation).toBe(true);
    expect((await readEntry(doc, contextOf(lost, all), SONIOX)).kind).not.toBe("open");
  });

  test("a tier generation signed by a member who was later revoked is not trusted", async () => {
    const [laptop, rogue] = [await testDevice(), await testDevice()];
    let doc = await maintain(EMPTY_VAULT, contextOf(rogue, [laptop, rogue]));
    doc = await maintain(doc, contextOf(laptop, [laptop, rogue]));
    expect(resolveVault(doc, contextOf(laptop, [laptop])).tier).toBeUndefined();
  });
});

describe("copies on two machines", () => {
  test("converge whichever order a device merges them in, and survive a JSON round trip", async () => {
    const [laptop, phone] = [await testDevice(), await testDevice()];
    const members = [laptop, phone];
    const base = await maintain(EMPTY_VAULT, contextOf(laptop, members));
    const onA = await writeEntry(base, contextOf(laptop, members), SONIOX, fields("sk-1"));
    const onB = await maintain(base, contextOf(phone, members));
    const ab = mergeVaults(onA, onB, MESH);
    expect(ab).toEqual(mergeVaults(onB, onA, MESH));
    expect(parseVaultDoc(JSON.parse(JSON.stringify(ab)))).toEqual(ab);
    expect(Object.keys(ab.entries)).toHaveLength(1);
    expect(Object.keys(ab.devices)).toHaveLength(2);
  });

  test("a malformed document reads as empty and a malformed item is dropped", () => {
    expect(parseVaultDoc("nope")).toEqual(EMPTY_VAULT);
    expect(parseVaultDoc({ v: 1, devices: { x: { body: 1 } }, tiers: {}, wraps: {}, entries: { y: {} } })).toEqual(
      EMPTY_VAULT,
    );
  });
});
