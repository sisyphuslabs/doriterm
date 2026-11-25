import { describe, expect, test } from "bun:test";
import { EMPTY_VAULT, mergeVaults, parseVaultDoc, type VaultDoc } from "./doc.ts";
import { MESH, contextOf, testDevice, type TestDevice } from "./testing.ts";
import { maintain, readEntry, resolveVault, writeEntry } from "./vault.ts";

const SONIOX = "soniox";
const fields = (key: string) => ({ $default: { type: "secret", value: key } }) as const;
const AGE = "YWdlLWVuY3J5cHRpb24"; // base64 of "age-encryption": every sealed wrap starts with it

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const asJson = (doc: VaultDoc): Json => JSON.parse(JSON.stringify(doc));

/** What any writer of a core's document can do: rewrite values in place, whatever the layout. */
function poison(value: Json): Json {
  if (typeof value === "string") return value.startsWith(AGE) ? "AAAA" : value;
  if (Array.isArray(value)) return value.map(poison);
  if (value === null || typeof value !== "object") return value;
  const out: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) out[key] = poison(item);
  if (typeof out["gen"] === "number" && typeof out["rev"] === "number" && typeof out["payload"] === "string")
    return { ...out, gen: Number.MAX_SAFE_INTEGER, rev: Number.MAX_SAFE_INTEGER, sig: "junk" };
  return out;
}

function plantHolder(value: Json): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const wraps = value["wraps"];
  if (wraps === null || typeof wraps !== "object" || Array.isArray(wraps) || wraps === undefined) return value;
  const planted: { [key: string]: Json } = {};
  for (const [tier, holders] of Object.entries(wraps)) {
    if (holders === null || typeof holders !== "object" || Array.isArray(holders)) continue;
    const first = Object.values(holders)[0];
    planted[tier] = first === undefined ? holders : { ...holders, intruder: first };
  }
  return { ...value, wraps: planted };
}

async function twoDeviceVault(): Promise<{ doc: VaultDoc; laptop: TestDevice; phone: TestDevice }> {
  const [laptop, phone] = [await testDevice(), await testDevice()];
  const members = [laptop, phone];
  let doc = await maintain(EMPTY_VAULT, contextOf(laptop, members));
  doc = await maintain(doc, contextOf(phone, members));
  doc = await maintain(doc, contextOf(laptop, members));
  doc = await writeEntry(doc, contextOf(laptop, members), SONIOX, fields("sk-1"));
  return { doc, laptop, phone };
}

describe("a hostile writer of one core's document", () => {
  test("cannot displace genuine wraps or entries: after the merge and a round of upkeep, devices still open the key", async () => {
    const { doc, laptop, phone } = await twoDeviceVault();
    const members = [laptop, phone];
    const hostile = parseVaultDoc(poison(asJson(doc)));
    let merged = mergeVaults(doc, hostile, MESH);
    merged = await maintain(merged, contextOf(phone, members));
    merged = await maintain(merged, contextOf(laptop, members));
    merged = mergeVaults(merged, hostile, MESH);
    const reads = await Promise.all(members.map((device) => readEntry(merged, contextOf(device, members), SONIOX)));
    for (const read of reads)
      expect(read.kind === "open" && read.payload.fields["$default"]).toEqual({ type: "secret", value: "sk-1" });
  });

  test("a copy that holds only the poisoned values, merged on its own, does not lock the vault for good", async () => {
    const { doc, laptop, phone } = await twoDeviceVault();
    const members = [laptop, phone];
    const merged = mergeVaults(parseVaultDoc(poison(asJson(doc))), doc, MESH);
    const read = await readEntry(merged, contextOf(phone, members), SONIOX);
    expect(read.kind).toBe("open");
  });

  test("cannot force a rotation by planting a holder no member wrapped to", async () => {
    const { doc, laptop, phone } = await twoDeviceVault();
    const members = [laptop, phone];
    const before = resolveVault(doc, contextOf(laptop, members)).tier?.gen;
    const planted = mergeVaults(doc, parseVaultDoc(plantHolder(asJson(doc))), MESH);
    const kept = await maintain(planted, contextOf(laptop, members));
    expect(resolveVault(kept, contextOf(laptop, members)).tier?.gen).toBe(before);
    const read = await readEntry(kept, contextOf(phone, members), SONIOX);
    expect(read.kind === "open" && read.payload.needsRotation).not.toBe(true);
  });
});

describe("items from keys outside the mesh", () => {
  test("are pruned by a member's upkeep, so a writer minting keys cannot grow the document without bound", async () => {
    const { doc, laptop, phone } = await twoDeviceVault();
    const members = [laptop, phone];
    const outsiders = await Promise.all([testDevice(), testDevice(), testDevice()]);
    const planted = await Promise.all(
      outsiders.map((outsider) => maintain(EMPTY_VAULT, contextOf(outsider, [outsider]))),
    );
    const junk = planted.reduce((merged, copy) => mergeVaults(merged, copy, MESH), doc);
    expect(Object.keys(junk.tiers).length).toBe(1 + outsiders.length);
    const kept = await maintain(junk, contextOf(laptop, members));
    expect(Object.keys(kept.tiers)).toEqual(Object.keys(doc.tiers));
    expect(Object.keys(kept.devices).toSorted()).toEqual(members.map((member) => member.signPub).toSorted());
    expect(Object.keys(kept.wraps)).toEqual(Object.keys(doc.wraps));
    const read = await readEntry(kept, contextOf(phone, members), SONIOX);
    expect(read.kind).toBe("open");
  });
});

describe("a machine that deletes a removed device's wrap", () => {
  test("cannot stop the rotation: a device that saw the wrap still rotates once that device is removed", async () => {
    const [laptop, phone, lost] = [await testDevice(), await testDevice(), await testDevice()];
    const all = [laptop, phone, lost];
    let doc = await maintain(EMPTY_VAULT, contextOf(laptop, all));
    doc = await maintain(doc, contextOf(phone, all));
    doc = await maintain(doc, contextOf(lost, all));
    doc = await maintain(doc, contextOf(laptop, all));
    doc = await writeEntry(doc, contextOf(laptop, all), SONIOX, fields("sk-1"));
    const tier = resolveVault(doc, contextOf(laptop, all)).tier;
    if (tier === undefined) throw new Error("expected a tier");
    const holders = { ...doc.wraps[tier.id] };
    delete holders[lost.signPub];
    const stripped: VaultDoc = { ...doc, wraps: { ...doc.wraps, [tier.id]: holders } };
    const after = await maintain(stripped, contextOf(laptop, [laptop, phone]));
    expect(resolveVault(after, contextOf(laptop, [laptop, phone])).tier?.gen).toBe(tier.gen + 1);
  });
});

describe("a generation no current member can open", () => {
  test("is replaced by a new one instead of staying locked forever", async () => {
    const [laptop, phone] = [await testDevice(), await testDevice()];
    let doc = await maintain(EMPTY_VAULT, contextOf(laptop, [laptop, phone]));
    const gen = resolveVault(doc, contextOf(laptop, [laptop, phone])).tier?.gen;
    const reinstalled = { ...laptop, key: (await testDevice()).key };
    doc = await maintain(doc, contextOf(reinstalled, [reinstalled, phone]));
    expect(resolveVault(doc, contextOf(phone, [reinstalled, phone])).tier?.gen).toBe((gen ?? 0) + 1);
    doc = await maintain(doc, contextOf(phone, [reinstalled, phone]));
    doc = await maintain(doc, contextOf(reinstalled, [reinstalled, phone]));
    doc = await writeEntry(doc, contextOf(phone, [reinstalled, phone]), SONIOX, fields("sk-2"));
    doc = await maintain(doc, contextOf(phone, [reinstalled, phone]));
    const read = await readEntry(doc, contextOf(reinstalled, [reinstalled, phone]), SONIOX);
    expect(read.kind).toBe("open");
  });
});
