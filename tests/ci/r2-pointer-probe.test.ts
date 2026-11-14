import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { probePointer } from "../../.github/scripts/r2-pointer-probe.ts";
import { evaluate } from "./gh-expression.ts";

type Sent = { url: string; method: string; headers: Headers };

const ROOT = join(import.meta.dir, "..", "..");
const SECRET = "secret-key-never-printed";
const ACCOUNT = "acct-never-printed";

/** R2 as #2609 describes it: a compressible object read with fetch's default Accept-Encoding answers a weak ETag. */
function fakeR2(sent: Sent[]) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    sent.push({ url, method: String(init.method), headers });
    return headers.get("accept-encoding") === "identity"
      ? new Response('{"version":"0.1.18"}', { headers: { etag: '"abc"', "content-length": "20" } })
      : new Response("gz", { headers: { etag: 'W/"abc"', "content-encoding": "gzip", "content-length": "2" } });
  };
}

const failing = async (url: string): Promise<Response> => {
  throw new TypeError(`could not reach ${url}`);
};

const probe = (fetcher: (url: string, init: RequestInit) => Promise<Response>, lines: string[]) =>
  probePointer({
    endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    bucket: "doriterm-releases",
    channel: "stable",
    accessKeyId: "id-never-printed",
    secretAccessKey: SECRET,
    now: () => new Date("2026-11-14T10:20:00.000Z"),
    fetcher,
    print: (line) => lines.push(line),
  });

test("the probe sends two GETs of the pointer, the second signing accept-encoding: identity, and prints only four fields of each", async () => {
  const sent: Sent[] = [];
  const lines: string[] = [];
  expect(await probe(fakeR2(sent), lines)).toBe(true);

  expect(lines).toEqual([
    'default: status=200 etag=W/"abc" content-encoding=gzip content-length=2',
    'identity: status=200 etag="abc" content-encoding=- content-length=20',
  ]);
  expect(sent.map(({ method }) => method)).toEqual(["GET", "GET"]);
  expect(sent.map(({ url }) => url)).toEqual([
    `https://${ACCOUNT}.r2.cloudflarestorage.com/doriterm-releases/channels/stable.json`,
    `https://${ACCOUNT}.r2.cloudflarestorage.com/doriterm-releases/channels/stable.json`,
  ]);
  const [plain, identity] = sent;
  expect(plain?.headers.get("accept-encoding")).toBeNull();
  expect(plain?.headers.get("authorization")).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date,");
  expect(identity?.headers.get("accept-encoding")).toBe("identity");
  expect(identity?.headers.get("authorization")).toContain(
    "SignedHeaders=accept-encoding;host;x-amz-content-sha256;x-amz-date,",
  );
  for (const line of lines)
    for (const secret of [ACCOUNT, SECRET, "id-never-printed", "Signature"]) {
      expect(line).not.toContain(secret);
    }
});

test("a request that fails prints only the error's name, never its message, and the probe reports the failure", async () => {
  const lines: string[] = [];
  expect(await probe(failing, lines)).toBe(false);
  expect(lines).toEqual(["default: request failed (TypeError)", "identity: request failed (TypeError)"]);
});

test("the workflow runs only by hand from dev, in the production mirror's environment, reading and never signing", () => {
  type Job = {
    if?: string;
    environment?: string;
    permissions?: unknown;
    steps?: { run?: string; env?: Record<string, string> }[];
  };
  const read = (name: string) =>
    Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", name), "utf8")) as {
      on: Record<string, unknown>;
      permissions?: Record<string, string>;
      jobs: Record<string, Job>;
    };
  const flow = read("r2-pointer-probe.yml");
  const job = flow.jobs["probe"];
  const production = evaluate(read("release-mirror.yml").jobs["mirror"]?.environment ?? "", {
    contexts: { inputs: { target: "production" } },
  });

  expect(Object.keys(flow.on)).toEqual(["workflow_dispatch"]);
  expect(flow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(flow.jobs)).toEqual(["probe"]);
  expect(job?.permissions).toBeUndefined();
  expect(job?.if).toBe("github.ref == 'refs/heads/dev'");
  expect([job?.environment, production]).toEqual(["release-mirror", "release-mirror"]);
  const names = (job?.steps ?? []).flatMap((step) => Object.keys(step.env ?? {}));
  expect(names.toSorted()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  for (const step of job?.steps ?? []) expect(step.run ?? "").not.toContain("${{");
});
