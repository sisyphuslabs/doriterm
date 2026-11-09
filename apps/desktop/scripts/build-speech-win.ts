import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Builds the Windows dictation addon (native/speech/speech-win.cc, #749) with MSVC for the CPU this runs on, through
 * scripts/build-speech-win.ps1. MSVC and the Windows SDK come with the Windows CI images and with Visual Studio's C++
 * desktop workload; without them the build fails, as the macOS build does without clang, so a release never ships
 * without dictation by accident.
 */
export async function buildWindowsSpeech(root: string): Promise<boolean> {
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("SAPI builds support x64 and arm64");
  const require = createRequire(import.meta.url);
  const headers = join(dirname(require.resolve("node-api-headers/package.json")), "include");
  const version = (require("electron/package.json") as { version: string }).version;
  const outdir = join(root, "dist", "native");
  mkdirSync(outdir, { recursive: true });
  // The import library must target Electron's node.exe exports, not a different Node runtime; one per version and CPU.
  const library = join(outdir, `node-v${version}-${process.arch}.lib`);
  if (!existsSync(library)) {
    const response = await fetch(
      `https://artifacts.electronjs.org/headers/dist/v${version}/win-${process.arch}/node.lib`,
    );
    if (!response.ok) throw new Error(`Electron import library: HTTP ${response.status}`);
    await Bun.write(library, response);
  }
  const proc = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "build-speech-win.ps1"),
      "-Root",
      root,
      "-Headers",
      headers,
      "-Library",
      library,
      "-Arch",
      process.arch,
    ],
    { env: process.env, stdout: "inherit", stderr: "inherit" },
  );
  return (await proc.exited) === 0;
}
