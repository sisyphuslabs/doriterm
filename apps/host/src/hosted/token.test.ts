import type { JsonWebKey } from "node:crypto";
import { beforeAll, expect, test } from "bun:test";
import { type AccessClaims, verifyAccessToken } from "./token.ts";

const ISSUER = "https://doriterm.com";
const AUDIENCE = "https://h1.mcp.doriterm.com/mcp";
const NOW = 1_800_000_000;
let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");

async function sign(
  claims: object,
  key = keys.privateKey,
  header: object = { alg: "ES256", kid: "k1" },
): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

const good = { iss: ISSUER, aud: AUDIENCE, sub: "agent-dots", scope: "read act", exp: NOW + 60, iat: NOW - 1 };
const verify = (token: string) =>
  verifyAccessToken(token, { issuer: ISSUER, audience: AUDIENCE, keys: [jwk], now: NOW });

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
});

test("a token signed by the issuer's key, for this host's URL and not expired, gives its agent and scopes", async () => {
  const claims: AccessClaims = await verify(await sign(good));
  expect(claims).toEqual({ agent: "agent-dots", scopes: ["read", "act"] });
});

test("an audience list that names this host is accepted; one that does not is refused", async () => {
  expect(await verify(await sign({ ...good, aud: ["https://x", AUDIENCE] }))).toMatchObject({ agent: "agent-dots" });
  await expect(verify(await sign({ ...good, aud: "https://other.mcp.doriterm.com/mcp" }))).rejects.toThrow("audience");
});

test.each([
  ["another key's signature", async () => sign(good, other.privateKey)],
  ["an unknown key id", async () => sign(good, keys.privateKey, { alg: "ES256", kid: "k9" })],
  ["alg none", async () => `${b64url('{"alg":"none","kid":"k1"}')}.${b64url(JSON.stringify(good))}.`],
  ["another issuer", async () => sign({ ...good, iss: "https://evil.example" })],
  ["an expired token", async () => sign({ ...good, exp: NOW - 1 })],
  ["no subject", async () => sign({ ...good, sub: undefined })],
  ["not three parts", async () => "abc.def"],
])("refuses %s", async (_, make) => {
  await expect(verify(await make())).rejects.toThrow();
});
