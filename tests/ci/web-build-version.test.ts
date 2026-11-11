import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WEB = join(ROOT, "apps", "web");
// The one source of the release version (.github/scripts/release-version.ts).
const declared = (
  JSON.parse(readFileSync(join(ROOT, "apps", "desktop", "package.json"), "utf8")) as { version: string }
).version;
const outDirs: string[] = [];
afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds apps/web with its own `build` script into a fresh scratch dir of its own, with DORIFACE_BUILD_VERSION set to
 * `given` or, when undefined, unset (as deploy-web.yml builds what production serves), and returns that dir's
 * manifest.webmanifest.
 */
async function builtManifest(given?: string): Promise<Record<string, unknown>> {
  const env = { ...process.env };
  delete env["DORIFACE_BUILD_VERSION"];
  if (given !== undefined) env["DORIFACE_BUILD_VERSION"] = given;
  const outDir = mkdtempSync(join(tmpdir(), "web-build-version-"));
  outDirs.push(outDir);
  const proc = Bun.spawn([process.execPath, "run", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`apps/web build exited ${code}: ${stderr}`);
  return JSON.parse(readFileSync(join(outDir, "manifest.webmanifest"), "utf8")) as Record<string, unknown>;
}

// #1556: the deployed app could not say which build it is. The static host serves dist as is, so the version is a member
// of the manifest it already ships. Each build takes most of a minute; bun runs the two tests one after the other, each
// into its own dir.
test("the built manifest carries the version apps/desktop/package.json declares", async () => {
  expect((await builtManifest())["version"]).toBe(declared);
}, 180_000);

// release.yml's desktop job sets DORIFACE_BUILD_VERSION to the resolved version, prerelease included; it wins over the
// declared one.
test("DORIFACE_BUILD_VERSION, when given, is the version the built manifest carries", async () => {
  const given = "9.9.9-rc.1";
  expect(given).not.toBe(declared);
  expect((await builtManifest(given))["version"]).toBe(given);
}, 180_000);
