import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildWindowsSpeech, buildWindowsSpeechOptional } from "./build-speech-win.ts";

/**
 * Builds the dictation addon (native/speech/speech.mm, #726) from source with clang: macOS only, universal (arm64 and
 * x86_64), Node-API so one build serves every Electron. electron-builder ships it under Resources/native and signs it
 * with the app. On Windows the SAPI addon (#749) is built with MSVC, and until that build is proven on the release
 * runners its failure is a warning, not a failed build. Elsewhere there is nothing to build: the app has no system
 * recognizer there.
 */
export async function buildSpeech(root: string): Promise<boolean> {
  if (process.platform === "win32") {
    // On GitHub Actions the line is an annotation on the run, so a release without dictation is seen.
    const prefix = process.env["GITHUB_ACTIONS"] === "true" ? "::warning title=Windows dictation::" : "";
    await buildWindowsSpeechOptional(root, buildWindowsSpeech, (line) => console.error(prefix + line));
    return true;
  }
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
