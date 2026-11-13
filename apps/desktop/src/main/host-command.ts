import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { readSaved, writeSaved } from "./window-state.ts";

export interface HostCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface HostContext {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const executable = (name: string, platform: NodeJS.Platform): string => (platform === "win32" ? `${name}.exe` : name);

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Packaged builds ship a compiled doriface-host; a checkout runs the workspace source with bun. */
export function hostCommand(context: HostContext): HostCommand {
  const override = context.env["DORIFACE_HOST_BIN"];
  if (override !== undefined && override !== "") return { file: override, args: [] };
  if (context.packaged) {
    return { file: join(context.resourcesPath, "bin", executable("doriface-host", context.platform)), args: [] };
  }
  const bun = context.env["BUN_BIN"];
  return {
    file: bun === undefined || bun === "" ? "bun" : bun,
    args: [join(context.appPath, "..", "host", "src", "cli.ts")],
  };
}

/**
 * The host script or binary a command runs: the first argument when the command is an interpreter plus a script
 * (a checkout runs `bun host/src/cli.ts`), the file itself otherwise (a packaged app's bundled binary).
 */
export function hostCliOf(command: HostCommand): string {
  return command.args.length > 0 ? (command.args[0] ?? command.file) : command.file;
}

/** Where herdr-core usually lands when PATH does not say. */
export function usualHcDirs(context: HostContext): readonly string[] {
  const home = [join(context.home, ".local", "bin"), join(context.home, ".cargo", "bin")];
  return context.platform === "win32" ? home : [...home, "/opt/homebrew/bin", "/usr/local/bin"];
}

/**
 * Finds herdr-core. Apps launched from a desktop session inherit a minimal PATH, so the usual install
 * directories are searched after it.
 */
export function findHc(
  context: HostContext,
  usual: readonly string[] = usualHcDirs(context),
  chosen?: string,
): string | undefined {
  const pinned = context.env["HC_BIN"];
  if (pinned !== undefined && pinned !== "") return pinned;
  if (chosen !== undefined) return chosen;
  const fromPath = (context.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  const name = executable("hc", context.platform);
  return [...fromPath, ...usual].map((dir) => join(dir, name)).find(isExecutable);
}

/** The hc chosen in the app (Choose hc), kept in `file` across launches; undefined when none was chosen. */
export function savedHc(file: string, log?: (line: string) => void): string | undefined {
  const saved = readSaved(file, log);
  const path: unknown = typeof saved === "object" && saved !== null ? Reflect.get(saved, "path") : undefined;
  return typeof path === "string" && path !== "" ? path : undefined;
}

export function saveHc(file: string, path: string): void {
  writeSaved(file, { path });
}
