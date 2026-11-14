import { expect, test } from "bun:test";
import { authorization, R2Store, sha256Hex } from "../../.github/scripts/r2-store.ts";

test("the signature matches AWS's own SigV4 example for a ranged GET", () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
  expect(
    authorization({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        Range: "bytes=0-9",
        "x-amz-content-sha256": sha256Hex(""),
        "x-amz-date": "20130524T000000Z",
      },
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    }),
  ).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("a pointer read for a replace gets the stored object's strong ETag, so the replace over it is accepted", async () => {
  // Cloudflare's edge compresses a JSON object for a client that accepts gzip and then answers with a weak ETag, which
  // never matches If-Match; the stored object's own ETag comes back only for an identity read.
  const stored = '"5f1c"';
  const store = new R2Store({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "doriterm-releases",
    accessKeyId: "id",
    secretAccessKey: "secret",
    fetcher: async (_url, init) => {
      const headers = new Headers(init.headers);
      if (init.method === "GET") {
        const identity = headers.get("accept-encoding") === "identity";
        return new Response("{}", { status: 200, headers: { etag: identity ? stored : `W/${stored}` } });
      }
      return new Response(null, { status: headers.get("if-match") === stored ? 200 : 412 });
    },
  });
  const pointer = await store.get("channels/stable.json");
  expect(pointer?.etag).toBe(stored);
  const body = new TextEncoder().encode("{}");
  expect(await store.put("channels/stable.json", body, { replace: pointer?.etag ?? "" }, "application/json")).toBe(true);
});

test("a write signs its body's hash and its condition, and a 412 or a 404 is an answer, not an error", async () => {
  const sent: { url: string; method: string; headers: Headers }[] = [];
  const statuses = [200, 412, 200, 404, 500];
  const store = new R2Store({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "doriterm-releases",
    accessKeyId: "id",
    secretAccessKey: "secret",
    now: () => new Date("2026-11-12T03:10:00.123Z"),
    fetcher: async (url, init) => {
      sent.push({ url, method: String(init.method), headers: new Headers(init.headers) });
      return new Response("body", { status: statuses.shift() ?? 500, headers: { etag: '"e1"' } });
    },
  });
  const body = new TextEncoder().encode("dmg");
  expect(
    await store.put("releases/v0.1.17/Doriterm 0.1.17.dmg", body, { create: true }, "application/octet-stream"),
  ).toBe(true);
  expect(await store.put("channels/stable.json", body, { replace: '"e0"' }, "application/json")).toBe(false);
  expect(await store.get("channels/stable.json")).toEqual({ body: new TextEncoder().encode("body"), etag: '"e1"' });
  expect(await store.get("channels/beta.json")).toBeNull();
  await expect(store.get("x")).rejects.toThrow("answered 500");

  const [create, replace] = sent;
  expect(create?.url).toBe(
    "https://acct.r2.cloudflarestorage.com/doriterm-releases/releases/v0.1.17/Doriterm%200.1.17.dmg",
  );
  expect(create?.headers.get("if-none-match")).toBe("*");
  expect(create?.headers.get("x-amz-content-sha256")).toBe(sha256Hex(body));
  expect(create?.headers.get("x-amz-date")).toBe("20261112T031000Z");
  expect(create?.headers.get("authorization")).toContain(
    "SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date",
  );
  expect(replace?.headers.get("if-match")).toBe('"e0"');
  expect(replace?.headers.get("if-none-match")).toBeNull();
});
