import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEYS as SHIPPED } from "../../../packages/crypto/src/release-keys.ts";
import { RELEASE_PUBLIC_KEYS as E2E } from "../e2e/release-keys.ts";
import { bundleOptions, MAIN_BUNDLE } from "../scripts/build.ts";

const dirs: string[] = [];
afterAll(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function mainBundle(env: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dd-release-keys-"));
  dirs.push(dir);
  const result = await Bun.build(bundleOptions(MAIN_BUNDLE, env, dir));
  expect(result.success).toBe(true);
  return readFileSync(join(dir, MAIN_BUNDLE.naming), "utf8");
}

test("the production main bundle trusts exactly the shipped release keys and holds no e2e key", async () => {
  const main = await mainBundle({});
  expect(SHIPPED.length).toBeGreaterThan(0);
  for (const key of SHIPPED) expect(main).toContain(key);
  for (const key of E2E) expect(main).not.toContain(key);
});

test("only a build asked for the e2e keys swaps them in, and it then holds no shipped key", async () => {
  const main = await mainBundle({ DORITERM_E2E_RELEASE_KEYS: "1" });
  for (const key of E2E) expect(main).toContain(key);
  for (const key of SHIPPED) expect(main).not.toContain(key);
  expect(await mainBundle({ DORITERM_E2E_RELEASE_KEYS: "0" })).toContain(SHIPPED[0] ?? "");
});

const runReleaseGuard = async (bundle: string): Promise<number> => {
  const dir = mkdtempSync(join(tmpdir(), "dd-release-guard-"));
  dirs.push(dir);
  const path = join(dir, "main.js");
  writeFileSync(path, bundle);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "scripts", "check-release-keys.ts"), path], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return child.exited;
};

test("the release-path bundle guard fails when the main bundle contains the e2e public key", async () => {
  expect(await runReleaseGuard(await mainBundle({ DORITERM_E2E_RELEASE_KEYS: "1" }))).toBe(1);
});

test("the release-path bundle guard accepts the production main bundle", async () => {
  expect(await runReleaseGuard(await mainBundle({}))).toBe(0);
});
