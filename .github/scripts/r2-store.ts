/**
 * The release bucket over R2's S3 API (#1969), signed with AWS Signature Version 4, so every write carries the SHA-256
 * of its body (R2 refuses a body whose hash differs) and the conditional headers the mirror depends on: If-None-Match: *
 * creates an immutable object or fails, If-Match: <etag> moves a pointer only over the exact one read.
 */
import { createHash, createHmac } from "node:crypto";

export interface StoredItem {
  readonly body: Uint8Array;
  readonly etag: string;
}

/** `create`: only if absent. `replace`: only over this ETag. `any`: unconditional (a manifest beside its pointer). */
export type PutCondition = { readonly create: true } | { readonly replace: string } | { readonly any: true };

export interface ObjectStore {
  get(key: string): Promise<StoredItem | null>;
  /** False when the condition failed (412): something else wrote or holds the key. */
  put(key: string, body: Uint8Array, condition: PutCondition, contentType: string): Promise<boolean>;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Every header to sign besides host, including x-amz-date and x-amz-content-sha256. */
  readonly headers: Readonly<Record<string, string>>;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

const encodeSegment = (segment: string): string =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header value for an S3 request (SigV4, service s3). */
export function authorization(input: SignInput): string {
  const headers: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim();
  const names = Object.keys(headers).toSorted();
  const amzDate = headers["x-amz-date"] ?? "";
  const payload = headers["x-amz-content-sha256"] ?? "";
  const canonical = [
    input.method,
    input.url.pathname,
    [...input.url.searchParams]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&"),
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    names.join(";"),
    payload,
  ].join("\n");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${names.join(";")},Signature=${signature}`;
}

export interface R2Options {
  /** https://<account>.r2.cloudflarestorage.com */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}

export class R2Store implements ObjectStore {
  private readonly options: R2Options;
  constructor(options: R2Options) {
    this.options = options;
  }

  private async send(method: string, key: string, body: Uint8Array | null, extra: Record<string, string>) {
    const { endpoint, bucket, accessKeyId, secretAccessKey, fetcher = fetch, now = () => new Date() } = this.options;
    const url = new URL(`${endpoint}/${encodeSegment(bucket)}/${key.split("/").map(encodeSegment).join("/")}`);
    const headers: Record<string, string> = {
      ...extra,
      "x-amz-date": now()
        .toISOString()
        .replaceAll(/[-:]/g, "")
        .replace(/\.\d{3}/, ""),
      "x-amz-content-sha256": body === null ? sha256Hex("") : sha256Hex(body),
    };
    headers["authorization"] = authorization({ method, url, headers, accessKeyId, secretAccessKey, region: "auto" });
    return fetcher(url.href, { method, headers, ...(body === null ? {} : { body }) });
  }

  async get(key: string): Promise<StoredItem | null> {
    // An identity read: for a client that accepts gzip, Cloudflare's edge compresses a JSON object and answers with a
    // weak ETag, which If-Match never matches, so every replace over it would fail with 412.
    const response = await this.send("GET", key, null, { "accept-encoding": "identity" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 GET ${key} answered ${response.status}`);
    return { body: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get("etag") ?? "" };
  }

  async put(key: string, body: Uint8Array, condition: PutCondition, contentType: string): Promise<boolean> {
    const extra: Record<string, string> = { "content-type": contentType };
    if ("create" in condition) extra["if-none-match"] = "*";
    if ("replace" in condition) extra["if-match"] = condition.replace;
    const response = await this.send("PUT", key, body, extra);
    if (response.status === 412) return false;
    if (!response.ok) throw new Error(`R2 PUT ${key} answered ${response.status}`);
    return true;
  }
}
