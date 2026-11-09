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
 * Builds apps/web with its own `build` script into a scratch dir, with no version given (as deploy-web.yml builds what
 * production serves), and returns that dir's manifest.webmanifest.
 */
async function builtManifest(): Promise<Record<string, unknown>> {
  const env = { ...process.env };
  delete env["DORIFACE_BUILD_VERSION"];
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
// of the manifest it already ships. One build only, since a build takes most of a minute.
test("the built manifest carries the version apps/desktop/package.json declares", async () => {
  expect((await builtManifest())["version"]).toBe(declared);
}, 180_000);
