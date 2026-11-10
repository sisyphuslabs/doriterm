import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./via.ts";

export const LAUNCHER = "doriface-host";
/** The host's own CLI: what a line's bridge runs from source, whichever script started this process. */
const CLI = join(import.meta.dir, "..", "cli.ts");

/**
 * The absolute program a mesh line's `via` names (section 7.2): this executable when it is one, else (a host run
 * from source) a launcher in the state dir that runs the host's CLI, so herdr's `sh -c` can start `connect --mesh`
 * with one quoted word. `main` only tells the two apart: under `bun test` it is a test file, never the bridge.
 * Windows has no `sh` to run such a launcher (#1385): a source run there names the CLI itself, which `meshVia` refuses
 * with the reason, so only the compiled host reaches other members.
 */
export function meshProgram(stateDir: string, main = Bun.main, platform = process.platform): string {
  if (!main.endsWith(".ts")) return process.execPath;
  if (platform === "win32") return CLI;
  const path = join(stateDir, LAUNCHER);
  const text = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text, { mode: 0o700 });
  return path;
}
