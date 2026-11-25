import { describe, expect, test } from "bun:test";
import { parseEntryName, publicKeyOf, type EntryPayload } from "typevault/core";
import { localKeyholder } from "./keyholder.ts";
import { remoteKeyholder, serveKeyholder } from "./keyholder-rpc.ts";
import { testDevice } from "./testing.ts";

const payload: EntryPayload = {
  v: 1,
  name: parseEntryName("soniox"),
  fields: { $default: { type: "secret", value: "sk-1" } },
  tags: [],
  created: "2026-11-24T00:00:00.000Z",
  rotated: "2026-11-24T00:00:00.000Z",
};

const bytesAsText = (_key: string, value: unknown): unknown =>
  value instanceof Uint8Array ? new TextDecoder().decode(value) : value;

describe("tier keys behind a keyholder", () => {
  test("the page side gets use-only handles: nothing it receives carries a tier key", async () => {
    const device = await testDevice();
    const serve = serveKeyholder(localKeyholder(device.deviceKey));
    const seen: unknown[] = [];
    const holder = await remoteKeyholder(async (request) => {
      const answer = await serve(structuredClone(request));
      seen.push(structuredClone(answer));
      return answer;
    });

    const created = await holder.generate(1);
    const wrap = await created.wrapFor(device.key.recipient);
    const handle = await holder.unwrap(wrap, 1, created.publicKey);
    if (handle === undefined) throw new Error("the device could not open its own wrap");
    const envelope = await handle.seal({
      id: "mesh.0123456789abcdef0123456789abcdef",
      rev: 1,
      at: payload.created,
      payload,
    });
    expect(await handle.open(envelope)).toEqual(payload);

    const wire = JSON.stringify(seen, bytesAsText);
    expect(wire).not.toContain("AGE-SECRET-KEY");
    expect(wire).not.toContain("tvk1:");
    expect(Object.keys(handle).toSorted()).toEqual(["gen", "open", "publicKey", "seal", "wrapFor"]);
  });

  test("handle ids cannot be derived from what the document makes public", async () => {
    const device = await testDevice();
    const serve = serveKeyholder(localKeyholder(device.deviceKey));
    const created = await serve({ op: "generate", gen: 1 });
    const id = String(Reflect.get(Object(created), "id"));
    const signPublic = String(Reflect.get(Object(Reflect.get(Object(created), "publicKey")), "signPublic"));
    expect(id).not.toContain(signPublic);
    await expect(serve({ op: "wrap", id: `1:${signPublic}`, recipient: device.deviceKey.recipient })).rejects.toThrow(
      "no such tier key",
    );
  });

  test("unwrap refuses a wrap of any other key than the expected tier key", async () => {
    const device = await testDevice();
    const holder = localKeyholder(device.deviceKey);
    const real = await holder.generate(1);
    const other = await holder.generate(1);
    const wrap = await other.wrapFor(device.key.recipient);
    expect(await holder.unwrap(wrap, 1, real.publicKey)).toBeUndefined();
    expect(await holder.unwrap(wrap, 2, other.publicKey)).toBeUndefined();
    expect(await holder.unwrap(new TextEncoder().encode("AAAA"), 1, other.publicKey)).toBeUndefined();
  });

  test("the served side refuses requests that are not keyholder calls", async () => {
    const serve = serveKeyholder(localKeyholder((await testDevice()).deviceKey));
    await expect(serve({ op: "unseal", sealed: new Uint8Array(1) })).rejects.toThrow("not a keyholder request");
    await expect(serve({ op: "open", id: "nope", envelope: {} })).rejects.toThrow();
    expect(typeof publicKeyOf).toBe("function");
  });
});
