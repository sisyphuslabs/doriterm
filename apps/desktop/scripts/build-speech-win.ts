import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Where the addon's build reads from and writes to. */
export interface AddonBuild {
  /** apps/desktop */
  readonly root: string;
  /** node-api-headers' include directory. */
  readonly headers: string;
  /** Electron's node.lib for this CPU. */
  readonly library: string;
  /** dist/native: cl.exe's working directory, where the objects and speech.node go. */
  readonly outdir: string;
}

/**
 * cl.exe's arguments: the compile of both sources in one call, and what `/link` passes to the linker. Electron's
 * node.lib binds the Node-API imports to node.exe, while Electron exports them from its own executable, which
 * electron-builder names Doriterm.exe; so node.exe is delay-loaded and the hook in win-delay-load-hook.cc answers that
 * load with the running executable, as node-gyp does for every addon it builds. Without it the packaged app failed to
 * load the addon and reported it can't dictate (#749).
 */
export function compilerArguments({ root, headers, library, outdir }: AddonBuild): {
  readonly compile: readonly string[];
  readonly link: readonly string[];
} {
  const sources = join(root, "native", "speech");
  return {
    compile: [
      "/nologo",
      "/std:c++17",
      "/EHsc",
      "/O2",
      "/W4",
      "/WX",
      "/MD",
      "/LD",
      "/DNODE_GYP_MODULE_NAME=speech",
      `/I${headers}`,
      join(sources, "speech-win.cc"),
      join(sources, "win-delay-load-hook.cc"),
    ],
    link: [
      `/OUT:${join(outdir, "speech.node")}`,
      library,
      "/DELAYLOAD:node.exe",
      "delayimp.lib",
      "sapi.lib",
      "ole32.lib",
      "uuid.lib",
    ],
  };
}

/** An argument with a space is quoted as on the command line. */
const quote = (argument: string): string => (/\s/.test(argument) ? `"${argument}"` : argument);

/**
 * The command file cl.exe reads (`cl.exe @file`). In a command file `/link` passes the rest of its line to the linker,
 * so the linker's arguments are a line of their own.
 */
export function compilerCommandFile({ compile, link }: ReturnType<typeof compilerArguments>): string {
  return `${compile.map(quote).join(" ")}\n/link ${link.map(quote).join(" ")}\n`;
}

/**
 * Builds the Windows dictation addon (native/speech/speech-win.cc, #749) with MSVC for the CPU this runs on, through
 * scripts/build-speech-win.ps1 (which finds the toolchain) from the command file written beside the output. MSVC and
 * the Windows SDK come with the Windows CI images and with Visual Studio's C++ desktop workload; without them, or
 * without Electron's import library, the build fails.
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
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`Electron import library: HTTP ${response.status}`);
    await Bun.write(library, response);
  }
  const commandFile = join(outdir, "speech.rsp");
  await Bun.write(commandFile, compilerCommandFile(compilerArguments({ root, headers, library, outdir })));
  const proc = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "build-speech-win.ps1"),
      "-CommandFile",
      commandFile,
      "-WorkingDirectory",
      outdir,
      "-Arch",
      process.arch,
    ],
    { env: process.env, stdout: "inherit", stderr: "inherit" },
  );
  return (await proc.exited) === 0;
}

/**
 * Builds the addon for the app to package, and when there is none says why instead of failing the build (#749). MSVC
 * through vcvarsall, the x64_arm64 cross toolset, `/W4 /WX` over this code and the node.lib download are unproven on
 * the release runners, so until a CI job proves them a release goes out without speech.node rather than not at all;
 * the app then tells the user it can't dictate. `warn` prints the one line that says so.
 */
export async function buildWindowsSpeechOptional(
  root: string,
  build: (root: string) => Promise<boolean>,
  warn: (line: string) => void,
): Promise<void> {
  let why: string;
  try {
    if (await build(root)) return;
    why = "the compiler exited non-zero";
  } catch (error) {
    why = error instanceof Error ? error.message : String(error);
  }
  warn(
    `no Windows dictation: speech.node was not built (${why}); the app packages without it and says it can't dictate`,
  );
}
