import { expect, test } from "bun:test";

const options = { hostname: "app.example.com", at: 1_795_747_200_000 };
const rawId = new Uint8Array(32).fill(29).buffer;
const p0 = new Uint8Array(32).fill(11).buffer;
const sealed = new Uint8Array([8, 9]);

test("S4: a browser must be WebKit and both stored identity keys must already be raw", async () => {
  const { rawCardForEnrollment } = await import("./passkey.ts");
  const safari = "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1";
  const chromium = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/139.0 Safari/537.36";
  const device = { kind: "raw", privateKey: new Uint8Array(32).fill(3) } as const;
  const card = { kind: "raw", privateKey: new Uint8Array(32).fill(5) } as const;
  expect(rawCardForEnrollment(safari, device, card)).toEqual(card.privateKey);
  expect(rawCardForEnrollment(chromium, device, card)).toBeUndefined();
  const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  expect(
    rawCardForEnrollment(safari, device, {
      kind: "webcrypto",
      privateKey: pair.privateKey,
      publicKey: new Uint8Array(32),
    }),
  ).toBeUndefined();
});

test("H5/M6/S7: every enrollment creates a fresh user handle, no mesh name, exact RP and a dated label", async () => {
  const { Passkey } = await import("./passkey.ts");
  const creates: CredentialCreationOptions[] = [];
  const credential = {
    rawId,
    id: "restore-id",
    extensions: { prf: { enabled: true, results: { first: p0 } }, largeBlob: { supported: true } },
  };
  const client = new Passkey(options.hostname, {
    create: async (o) => {
      creates.push(o);
      return credential;
    },
    get: async () => undefined,
  });
  await client.create(options.at);
  await client.create(options.at);
  expect(creates).toHaveLength(2);
  const [first, second] = creates.map((request) => request.publicKey);
  expect(first?.rp.id).toBe("app.example.com");
  expect(first?.user.name).toMatch(/^Doriterm on this phone \d{4}-\d{2}-\d{2}$/);
  expect(first?.user.displayName).toBe(first?.user.name);
  expect(first?.user.id.byteLength).toBe(32);
  expect(first?.user.id).not.toEqual(second?.user.id);
  expect(first?.authenticatorSelection?.residentKey).toBe("required");
});

test("M4/S2/S7: a credential created without PRF is retired, not written or accepted", async () => {
  const { Passkey } = await import("./passkey.ts");
  const retired: unknown[] = [];
  const client = new Passkey(options.hostname, {
    create: async () => ({
      rawId,
      id: "restore-id",
      extensions: { prf: { enabled: false }, largeBlob: { supported: true } },
    }),
    get: async () => {
      throw new Error("must not get an assertion");
    },
    retire: async (signal) => {
      retired.push(signal);
    },
  });
  await expect(client.create(options.at)).rejects.toThrow("PRF");
  expect(retired).toEqual([{ rpId: options.hostname, credentialId: "restore-id" }]);
});

test("M8/S6/S8: discovery reads PRF and largeBlob together; second assertion writes only to the discovered credential", async () => {
  const { Passkey } = await import("./passkey.ts");
  const gets: CredentialRequestOptions[] = [];
  const client = new Passkey(options.hostname, {
    create: async () => undefined,
    get: async (request) => {
      gets.push(request);
      const extensions =
        gets.length === 1
          ? { prf: { results: { first: p0 } }, largeBlob: { blob: sealed.buffer } }
          : { largeBlob: { written: false } };
      return { rawId, id: "restore-id", extensions };
    },
  });
  const read = await client.read();
  expect(read.bytes).toEqual(sealed);
  await expect(client.write(read.credential, sealed)).rejects.toThrow("not written");
  expect(gets).toHaveLength(2);
  expect(gets[0]?.publicKey?.allowCredentials).toEqual([]);
  expect(gets[0]?.publicKey?.extensions).toMatchObject({
    prf: { eval: { first: expect.any(Uint8Array) } },
    largeBlob: { read: true },
  });
  expect(gets[1]?.publicKey?.allowCredentials).toEqual([{ id: rawId, type: "public-key" }]);
  expect(gets[1]?.publicKey?.extensions).toEqual({ largeBlob: { write: sealed } });
});
