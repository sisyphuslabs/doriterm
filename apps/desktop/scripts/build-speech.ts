import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Builds the dictation addon (native/speech/speech.mm, #726) from source with clang: macOS only, universal (arm64 and
 * x86_64), Node-API so one build serves every Electron. electron-builder ships it under Resources/native and signs it
 * with the app. Elsewhere there is nothing to build: the app has no system recognizer there.
 */
export async function buildSpeech(root: string): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const headers = join(dirname(createRequire(import.meta.url).resolve("node-api-headers/package.json")), "include");
  const outdir = join(root, "dist", "native");
  mkdirSync(outdir, { recursive: true });
  const proc = Bun.spawn(
    [
      "clang++",
      "-std=c++17",
      "-ObjC++",
      "-fobjc-arc",
      "-O2",
      "-Wall",
      "-Werror",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-mmacosx-version-min=12.0",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      "-DNODE_GYP_MODULE_NAME=speech",
      `-I${headers}`,
      "-framework",
      "Foundation",
      "-framework",
      "AVFoundation",
      "-framework",
      "Speech",
      "-framework",
      "UserNotifications",
      join(root, "native", "speech", "speech.mm"),
      "-o",
      join(outdir, "speech.node"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const ok = (await proc.exited) === 0;
  if (ok) console.log(`built ${join("dist", "native", "speech.node")}`);
  return ok;
}

if (import.meta.main) process.exit((await buildSpeech(join(import.meta.dir, ".."))) ? 0 : 1);
