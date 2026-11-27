import type { BunPlugin } from "bun";
import { join } from "node:path";
import { buildSpeech } from "./build-speech.ts";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist", "app");

/** Electron loads the main process as ESM; a sandboxed preload must be a single CommonJS file. */
const bundles = [
  { entry: "src/main/main.ts", format: "esm", naming: "main.js" },
  { entry: "src/preload/preload.ts", format: "cjs", naming: "preload.cjs" },
] as const;

/**
 * A desktop e2e build only (DORITERM_E2E_RELEASE_KEYS=1, set by CI's e2e packaging): the release keys the app trusts
 * become e2e/release-keys.ts, so a spec can sign a fixture herdr-core manifest (#2945). The app itself keeps no way to
 * add a key at run time; every other build carries packages/crypto/src/release-keys.ts as it is.
 */
const e2eReleaseKeys: BunPlugin = {
  name: "e2e-release-keys",
  setup(build) {
    build.onResolve({ filter: /\/release-keys\.ts$/ }, (args) =>
      args.importer.endsWith(join("packages", "crypto", "src", "release.ts"))
        ? { path: join(root, "e2e", "release-keys.ts") }
        : undefined,
    );
  },
};

export const bundleOptions = (
  bundle: (typeof bundles)[number],
  env: Readonly<Record<string, string | undefined>>,
  into = outdir,
): Parameters<typeof Bun.build>[0] => ({
  entrypoints: [join(root, bundle.entry)],
  outdir: into,
  naming: bundle.naming,
  target: "node",
  format: bundle.format,
  external: ["electron"],
  sourcemap: "linked",
  plugins: env["DORITERM_E2E_RELEASE_KEYS"] === "1" ? [e2eReleaseKeys] : [],
});

export const MAIN_BUNDLE = bundles[0];

const build = async (bundle: (typeof bundles)[number]): Promise<boolean> => {
  const result = await Bun.build(bundleOptions(bundle, process.env));
  for (const message of result.logs) console.error(message);
  if (result.success) console.log(`built ${join("dist", "app", bundle.naming)}`);
  return result.success;
};

if (import.meta.main) {
  const results = await Promise.all([...bundles.map(build), buildSpeech(root)]);
  if (results.includes(false)) process.exit(1);
}
