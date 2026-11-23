import { base64urlDecode, fingerprintOf } from "@doriface/crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRANT_EXPIRY, mcpGrantFor } from "../testing/mcp-grant.ts";
import { grantIdOf, MCP_GRANTS_FILE, McpGrantStore } from "./mcp-grants.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-mcp-grants-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a missing grant file is off and empty", () => {
  const store = new McpGrantStore(dir);
  expect(store.enabled()).toBe(false);
  expect(store.list()).toEqual([]);
});

test("a second store reads the enabled flag and complete grant from the private file", () => {
  const grant = mcpGrantFor();
  const writer = new McpGrantStore(dir);
  writer.setEnabled(true);
  writer.add(grant);

  const reader = new McpGrantStore(dir);
  expect(reader.enabled()).toBe(true);
  expect(reader.list()).toEqual([grant]);
  if (process.platform !== "win32") expect(statSync(join(dir, MCP_GRANTS_FILE)).mode & 0o777).toBe(0o600);
});

test("adding the same key replaces its grant rather than duplicating the row", () => {
  const store = new McpGrantStore(dir);
  const grant = mcpGrantFor();
  const replacement = { ...grant, name: "another name" };
  store.add(grant);
  store.add(replacement);
  expect(store.list()).toEqual([replacement]);
});

test("a grant stops being live at the exact expiry millisecond", () => {
  const store = new McpGrantStore(dir);
  const grant = mcpGrantFor();
  store.setEnabled(true);
  store.add(grant);
  expect(store.live(grant.key, GRANT_EXPIRY - 1)).toEqual(grant);
  expect(store.live(grant.key, GRANT_EXPIRY)).toBeUndefined();
  expect(store.holds(grant.key)).toBe(true);
});

test("a burned key cannot be reused to regain access", () => {
  const store = new McpGrantStore(dir);
  const grant = mcpGrantFor();
  store.setEnabled(true);
  store.add(grant);
  store.revoke(grant.key);
  expect(store.holds(grant.key)).toBe(true);
  expect(store.live(grant.key, 0)).toBeUndefined();
  expect(() => store.add(grant)).toThrow(/burned key/);
});

test.each([
  ["short id", (key: string) => fingerprintOf(base64urlDecode(key)).replaceAll(" ", "").slice(0, 8).toLowerCase()],
  ["full fingerprint", (key: string) => fingerprintOf(base64urlDecode(key)).toLowerCase()],
  ["base64url key", (key: string) => key],
])("revoke resolves the grant by %s", (_name, handle) => {
  const store = new McpGrantStore(dir);
  const grant = mcpGrantFor();
  const other = mcpGrantFor();
  store.add(grant);
  store.add(other);
  expect(store.revoke(handle(grant.key))).toEqual([grant]);
  expect(store.list()).toEqual([other]);
});

test("an ambiguous short id refuses to revoke either key", () => {
  const store = new McpGrantStore(dir);
  const a = { ...mcpGrantFor(), key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxJM" };
  const b = { ...mcpGrantFor(), key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0_Q" };
  store.add(a);
  store.add(b);
  expect(grantIdOf(a)).toBe("93613343");
  expect(() => store.revoke("93613343")).toThrow(/matches 2 grants/);
  expect(store.list()).toEqual([a, b]);
});

test("the next live lookup sees an atomic replacement by another store instance", () => {
  const reader = new McpGrantStore(dir);
  const writer = new McpGrantStore(dir);
  const grant = mcpGrantFor();
  writer.setEnabled(true);
  writer.add(grant);
  expect(reader.live(grant.key, 0)).toEqual(grant);
  writer.revoke(grant.key);
  expect(reader.live(grant.key, 0)).toBeUndefined();
  expect(reader.holds(grant.key)).toBe(true);
});

const grant = mcpGrantFor();
const state = { version: 1, enabled: true, grants: [grant], burned: [] };
const withGrant = (entry: object) => ({ ...state, grants: [{ ...grant, ...entry }] });

test.each([
  ["another version", { ...state, version: 2 }],
  ["an unknown file field", { ...state, allowAll: true }],
  ["a non-boolean enabled flag", { ...state, enabled: "true" }],
  ["a missing burned list", { ...state, burned: undefined }],
  ["a non-array grant list", { ...state, grants: { ...grant } }],
  ["an unknown grant field", withGrant({ owner: true })],
  ["a missing grant field", withGrant({ approvedBy: undefined })],
  ["a truncated X25519 key", withGrant({ key: "wrong" })],
  ["an invalid burned key", { ...state, burned: ["wrong"] }],
  ["an unknown grant kind", withGrant({ kind: "owner" })],
  ["an unknown scope", withGrant({ scopes: { "terminals:attach": "allow" } })],
  ["an unknown mode", withGrant({ scopes: { "files:read": "yes" } })],
  ["exec without approval", withGrant({ scopes: { exec: "allow" } })],
  ["the wrong selector fields", withGrant({ terminals: { kind: "all", spaces: [] } })],
  ["the wrong spaces type", withGrant({ terminals: { kind: "spaces", spaces: [1] } })],
  ["a non-string folder", withGrant({ folders: [1] })],
  ["a non-string template", withGrant({ templates: [1] })],
  ["an unknown confirmation mode", withGrant({ confirm: "none" })],
  ["a non-ISO creation time", withGrant({ createdAt: "yesterday" })],
  ["an unsafe expiry", withGrant({ expiresAt: Number.MAX_SAFE_INTEGER + 1 })],
  ["a fractional expiry", withGrant({ expiresAt: 0.5 })],
  ["a duplicate grant key", { ...state, grants: [grant, grant] }],
  ["a duplicate burned key", { ...state, grants: [], burned: [grant.key, grant.key] }],
  ["a key that is granted and burned", { ...state, burned: [grant.key] }],
])("fails closed on %s and names the file", (_name, value) => {
  writeFileSync(join(dir, MCP_GRANTS_FILE), JSON.stringify(value));
  expect(() => new McpGrantStore(dir).list()).toThrow(MCP_GRANTS_FILE);
});

test("invalid JSON reports the grant file rather than a bare syntax error", () => {
  writeFileSync(join(dir, MCP_GRANTS_FILE), "{");
  expect(() => new McpGrantStore(dir).enabled()).toThrow(MCP_GRANTS_FILE);
});
