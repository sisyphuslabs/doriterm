import { join } from "node:path";
import { buildSpeech } from "./build-speech.ts";

const root = join(import.meta.dir, "..");
const outdir = join(root, "dist", "app");

/** Electron loads the main process as ESM; a sandboxed preload must be a single CommonJS file. */
const bundles = [
  { entry: "src/main/main.ts", format: "esm", naming: "main.js" },
  { entry: "src/preload/preload.ts", format: "cjs", naming: "preload.cjs" },
] as const;

const build = async (bundle: (typeof bundles)[number]): Promise<boolean> => {
  const result = await Bun.build({
    entrypoints: [join(root, bundle.entry)],
    outdir,
    naming: bundle.naming,
    target: "node",
    format: bundle.format,
    external: ["electron"],
    sourcemap: "linked",
  });
  for (const message of result.logs) console.error(message);
  if (result.success) console.log(`built ${join("dist", "app", bundle.naming)}`);
  return result.success;
};

const results = await Promise.all([...bundles.map(build), buildSpeech(root)]);
if (results.includes(false)) process.exit(1);
