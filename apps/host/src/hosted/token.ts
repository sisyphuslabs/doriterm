import type { JsonWebKey } from "node:crypto";
/** What a verified access token grants: the approved agent it names and the scopes it carries. */
export interface AccessClaims {
  readonly agent: string;
  readonly scopes: readonly string[];
}

export interface TokenRules {
  readonly issuer: string;
  /** This host's MCP URL: a token for any other resource is refused (RFC 8707 audience binding). */
  readonly audience: string;
  /** The issuer's signing keys (its JWKS), ES256 only. */
  readonly keys: readonly (JsonWebKey & { readonly kid?: string })[];
  /** Seconds since the epoch. */
  readonly now: number;
}

/** A token that is not one the issuer made for this host, now. */
export class TokenRefused extends Error {}

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const field = (value: unknown, key: string): unknown => Reflect.get(Object(value), key);

/** Verifies an ES256 JWT access token against the issuer's keys and this host's audience. */
export async function verifyAccessToken(token: string, rules: TokenRules): Promise<AccessClaims> {
  const parts = token.split(".");
  const [head = "", body = "", signature = ""] = parts;
  if (parts.length !== 3 || signature === "") throw new TokenRefused("a token has three parts and a signature");
  const header = decode(head);
  if (field(header, "alg") !== "ES256") throw new TokenRefused("only ES256 tokens are accepted");
  const jwk = rules.keys.find((key) => key.kid === field(header, "kid"));
  if (jwk === undefined) throw new TokenRefused("the token's key is not the issuer's");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signed = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!signed) throw new TokenRefused("the token's signature does not verify");
  const claims = decode(body);
  if (field(claims, "iss") !== rules.issuer) throw new TokenRefused("the token is from another issuer");
  const audience = field(claims, "aud");
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(rules.audience)) throw new TokenRefused("the token's audience is not this host");
  const expires = field(claims, "exp");
  if (typeof expires !== "number" || expires <= rules.now) throw new TokenRefused("the token has expired");
  const agent = field(claims, "sub");
  if (typeof agent !== "string" || agent === "") throw new TokenRefused("the token names no agent");
  const scope = field(claims, "scope");
  return { agent, scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [] };
}
