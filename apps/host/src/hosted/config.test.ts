import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAudit,
  approvedAgent,
  HOSTED_AGENTS_FILE,
  HOSTED_AUDIT_FILE,
  hostedFromEnv,
  issuerKeys,
} from "./config.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-hosted-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setup = (env: Record<string, string>, mcpOn = true) =>
  hostedFromEnv({ env, stateDir: dir, hostId: HOST_ID, serve: () => {}, mcpOn: () => mcpOn });
const HOST_ID = "xaskhrycovp63efjlwvy4v3jcu";
const ON = { DORIFACE_HOSTED_MCP: "1", DORIFACE_HOSTED_MCP_URL: "https://h1.mcp.doriterm.com/mcp" };

test("the URL endpoint exists only with DORIFACE_HOSTED_MCP=1: off by default", () => {
  expect(setup({})).toBeUndefined();
  expect(setup({ DORIFACE_HOSTED_MCP_URL: ON.DORIFACE_HOSTED_MCP_URL })).toBeUndefined();
  expect(setup(ON)).toBeFunction();
});

test("without an override the endpoint lives at the host's own name, derived from its key", async () => {
  const handle = setup({ DORIFACE_HOSTED_MCP: "1" });
  const response = await handle?.(
    new Request(`https://${HOST_ID}.mcp.doriterm.com/.well-known/oauth-protected-resource`),
  );
  expect(await response?.json()).toMatchObject({ resource: `https://${HOST_ID}.mcp.doriterm.com/mcp` });
});

test("with MCP turned off on the host, the URL endpoint refuses everything, the metadata included", async () => {
  const handle = setup(ON, false);
  const response = await handle?.(new Request("https://h1.mcp.doriterm.com/.well-known/oauth-protected-resource"));
  expect(response?.status).toBe(403);
});

test("approved agents come from the host's own file, and an agent missing from it has none", () => {
  expect(approvedAgent(dir, "dots")).toBeUndefined();
  writeFileSync(
    join(dir, HOSTED_AGENTS_FILE),
    JSON.stringify({ version: 1, agents: { dots: { name: "Dots", scopes: ["read", 7] } } }),
  );
  expect(approvedAgent(dir, "dots")).toEqual({ name: "Dots", scopes: ["read"] });
  expect(approvedAgent(dir, "grok")).toBeUndefined();
});

test("without a key file there are no issuer keys, so no token can verify", () => {
  expect(issuerKeys(dir)).toEqual([]);
});

test.skipIf(process.platform === "win32")("an audited call is appended owner-only, one JSON line each", () => {
  const line = { at: 1, agent: "dots", method: "tools/call", tool: "file_read", ok: true };
  appendAudit(dir, line);
  appendAudit(dir, { ...line, at: 2, ok: false });
  const path = join(dir, HOSTED_AUDIT_FILE);
  expect(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row)),
  ).toEqual([line, { ...line, at: 2, ok: false }]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
