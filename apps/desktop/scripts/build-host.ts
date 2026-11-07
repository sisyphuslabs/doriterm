import { join } from "node:path";

/** electron-builder's `${os}-${arch}` resource directory -> bun's compile target. */
const TARGETS = {
  "mac-arm64": "bun-darwin-arm64",
  "mac-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "win-x64": "bun-windows-x64",
  "win-arm64": "bun-windows-arm64",
} as const;

export type Target = keyof typeof TARGETS;

const isTarget = (value: string): value is Target => Object.hasOwn(TARGETS, value);
const OS_NAMES: Readonly<Record<string, string>> = { darwin: "mac", linux: "linux", win32: "win" };

const root = join(import.meta.dir, "..");
const cli = join(root, "..", "host", "src", "cli.ts");

/** The target of the machine this runs on. */
export function nativeTarget(): Target {
  const name = `${OS_NAMES[process.platform] ?? process.platform}-${process.arch}`;
  if (!isTarget(name)) throw new Error(`no host target for ${name}`);
  return name;
}

/**
 * Compiles the host for `name` into `outfile`. A `version` (a release's, prerelease suffix included) is what the host
 * then reports; without one it reports apps/desktop/package.json's.
 */
export async function compileHost(name: Target, outfile: string, version?: string): Promise<number> {
  const define = version === undefined ? [] : ["--define", `DORIFACE_BUILD_VERSION=${JSON.stringify(version)}`];
  const proc = Bun.spawn(
    [process.execPath, "build", "--compile", `--target=${TARGETS[name]}`, ...define, cli, "--outfile", outfile],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return proc.exited;
}

if (import.meta.main) {
  const requested = Bun.argv.slice(2);
  const names = requested.includes("all") ? Object.keys(TARGETS) : requested.length > 0 ? requested : [nativeTarget()];
  const unknown = names.filter((name) => !isTarget(name));
  if (unknown.length > 0) {
    console.error(
      `unknown host target ${unknown.join(", ")}; expected all or one of ${Object.keys(TARGETS).join(", ")}`,
    );
    process.exit(2);
  }
  // The release sets the version it builds; a local build reports apps/desktop/package.json's.
  const version = process.env["DORIFACE_BUILD_VERSION"] || undefined;
  const outfile = (name: Target): string =>
    join(root, "dist", "host", name, name.startsWith("win-") ? "doriface-host.exe" : "doriface-host");
  const codes = await Promise.all(names.filter(isTarget).map((name) => compileHost(name, outfile(name), version)));
  if (codes.some((code) => code !== 0)) process.exit(1);
}
