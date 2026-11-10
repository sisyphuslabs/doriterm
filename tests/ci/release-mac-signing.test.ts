import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// v0.1.16 shipped doriface-host-mac-arm64 with only the ad-hoc signature bun build --compile leaves, so Gatekeeper
// rejected it (#1992): the release signed and notarized the app and the dmg, and copied the standalone host as built.

type Step = { name?: string; if?: string; run?: string; env?: Record<string, string>; "working-directory"?: string };
type Job = { steps: Step[]; strategy?: { matrix?: { include?: Array<{ os?: string; files?: string }> } } };
type Workflow = { jobs: Record<string, Job> };

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPTS = join(ROOT, ".github", "scripts");
const release = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8")) as Workflow;

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`release.yml has no ${what}`);
  return value;
}

const desktop = must(release.jobs["desktop"], "desktop job");
const HOST = "apps/desktop/dist/host/${{ matrix.os }}-${{ matrix.arch }}/doriface-host";

const stepIndex = (job: Job, predicate: (step: Step) => boolean): number => job.steps.findIndex(predicate);
const runsOnMac = (step: Step): boolean => step.if === "matrix.os == 'mac'" || step.if === "matrix.os != 'win'";

test("a mac desktop job uploads only the dmg and zip electron-builder signs, and the standalone host", () => {
  const macFiles = (desktop.strategy?.matrix?.include ?? []).filter((row) => row.os === "mac").map((row) => row.files);
  expect(macFiles).toEqual(["dmg zip", "dmg zip"]);
  const collect = desktop.steps.find((step) => step.name === "Collect the standalone host");
  expect(collect?.run).toContain(`cp "${HOST}" `);
});

test("the standalone host is signed, notarized and assessed before it is collected", () => {
  const sign = stepIndex(desktop, (step) => step.run?.includes("macos-sign-binary.sh") ?? false);
  const assess = stepIndex(desktop, (step) => step.run?.includes("macos-assess-binary.sh") ?? false);
  const collect = stepIndex(desktop, (step) => step.name === "Collect the standalone host");
  expect({ sign: sign >= 0, assess: assess >= 0 }).toEqual({ sign: true, assess: true });
  expect(sign).toBeLessThan(assess);
  expect(assess).toBeLessThan(collect);

  const signStep = must(desktop.steps[sign], "signing step");
  expect(runsOnMac(signStep)).toBe(true);
  expect(signStep.env?.["HOST"]).toBe(HOST);
  expect(signStep.run).toContain(
    'bash .github/scripts/macos-sign-binary.sh "$HOST" apps/desktop/build/entitlements.host.mac.plist',
  );
  expect(signStep.run).toContain('bash .github/scripts/macos-notarize.sh "$HOST"');
  // The notary key is written before this step and forgotten after it.
  const keyWritten = stepIndex(desktop, (step) => step.name === "App Store Connect API key");
  const keyForgotten = stepIndex(desktop, (step) => step.name === "Forget the App Store Connect API key");
  expect(keyWritten).toBeLessThan(sign);
  expect(sign).toBeLessThan(keyForgotten);

  const assessStep = must(desktop.steps[assess], "assessment step");
  expect(runsOnMac(assessStep)).toBe(true);
  expect(assessStep.run).toContain(`macos-assess-binary.sh "${HOST}"`);
});

test("the mac smoke assesses the standalone host it downloads from the draft release", () => {
  const smoke = must(release.jobs["smoke-mac"], "smoke-mac job");
  const download = smoke.steps.find((step) => step.run?.includes("gh release download"));
  expect(download?.run).toContain('--pattern "$host"');
  expect(download?.run).toContain("host=doriface-host-mac-arm64");
  const assess = smoke.steps.find((step) => step.run?.includes("macos-assess-binary.sh"));
  expect(assess?.run).toContain('macos-assess-binary.sh" doriface-host-mac-arm64');
});

test("the host is signed under the hardened runtime with entitlements that let bun JIT", () => {
  const plist = readFileSync(join(ROOT, "apps", "desktop", "build", "entitlements.host.mac.plist"), "utf8");
  expect(plist).toMatch(/<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
  expect(plist).not.toContain("com.apple.security.app-sandbox");
  const sign = readFileSync(join(SCRIPTS, "macos-sign-binary.sh"), "utf8");
  expect(sign).toMatch(/codesign --force --timestamp --options runtime --entitlements "\$entitlements"/);
});

// macos-assess-binary.sh against stand-ins for codesign and spctl. The spctl stand-in behaves as the real one does on a
// bare binary: the execute type rejects it as "not an app" whatever its signature, only the install type assesses it.

const NOTARIZED = [
  "Executable=/tmp/doriface-host",
  "Identifier=doriface-host",
  "Format=Mach-O thin (arm64)",
  "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded",
  "Authority=Developer ID Application: Example (ABCDE12345)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
].join("\n");
// What bun build --compile leaves on the binary.
const ADHOC = [
  "Executable=/tmp/doriface-host",
  "CodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded",
  "Signature=adhoc",
].join("\n");
const NO_RUNTIME = NOTARIZED.replace("flags=0x10000(runtime)", "flags=0x0(none)");

const STUBS: Record<string, string> = {
  codesign: `#!/bin/sh
case "$1" in
  --verify) exit 0 ;;
  -dvv) cat "$STUB_DIR/details" >&2; exit 0 ;;
esac
exit 2
`,
  spctl: `#!/bin/sh
n=$(($(cat "$STUB_DIR/spctl-calls" 2>/dev/null || echo 0) + 1))
echo "$n" > "$STUB_DIR/spctl-calls"
for last in "$@"; do :; done
case " $* " in
  *" --type install "* | *" -t install "*) ;;
  *) echo "$last: rejected (the code is valid but does not seem to be an app)" >&2; exit 3 ;;
esac
if [ "$n" -ge "$STUB_ACCEPT_AT" ]; then
  printf '%s: accepted\\nsource=Notarized Developer ID\\n' "$last" >&2
  exit 0
fi
printf '%s: rejected\\nsource=Unnotarized Developer ID\\n' "$last" >&2
exit 3
`,
  // The retry waits are not what is under test.
  sleep: "#!/bin/sh\nexit 0\n",
};

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function runAssessment(details: string, acceptAt: number): { code: number; output: string; spctlCalls: number } {
  const dir = mkdtempSync(join(tmpdir(), "macos-assess-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, script] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, "details"), details);
  writeFileSync(join(dir, "doriface-host"), "binary");
  const result = Bun.spawnSync(["bash", join(SCRIPTS, "macos-assess-binary.sh"), join(dir, "doriface-host")], {
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, STUB_DIR: dir, STUB_ACCEPT_AT: String(acceptAt) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = join(dir, "spctl-calls");
  return {
    code: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
    spctlCalls: existsSync(calls) ? Number(readFileSync(calls, "utf8").trim()) : 0,
  };
}

test("a notarized Developer ID binary under the hardened runtime passes", () => {
  const result = runAssessment(NOTARIZED, 1);
  expect({ code: result.code, spctlCalls: result.spctlCalls }).toEqual({ code: 0, spctlCalls: 1 });
});

test("Gatekeeper's online lookup that lags notarization is retried", () => {
  const result = runAssessment(NOTARIZED, 3);
  expect({ code: result.code, spctlCalls: result.spctlCalls }).toEqual({ code: 0, spctlCalls: 3 });
});

test("an unnotarized binary fails after the bounded retries", () => {
  const result = runAssessment(NOTARIZED, Number.MAX_SAFE_INTEGER);
  expect({ code: result.code, spctlCalls: result.spctlCalls }).toEqual({ code: 1, spctlCalls: 10 });
  expect(result.output).toContain("::error title=Gatekeeper::");
});

test("the ad-hoc signature bun leaves fails before Gatekeeper is asked", () => {
  const result = runAssessment(ADHOC, 1);
  expect({ code: result.code, spctlCalls: result.spctlCalls }).toEqual({ code: 1, spctlCalls: 0 });
});

test("a Developer ID signature without the hardened runtime fails", () => {
  const result = runAssessment(NO_RUNTIME, 1);
  expect({ code: result.code, spctlCalls: result.spctlCalls }).toEqual({ code: 1, spctlCalls: 0 });
});
