import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./via.ts";

export const LAUNCHER = "doriface-host";

/**
 * The absolute program a mesh line's `via` names (section 7.2): this executable when it is one, else (a host run
 * from source as `bun cli.ts`) a launcher in the state dir that runs the same entry point, so herdr's `sh -c` can
 * start `connect --mesh` with one quoted word.
 */
export function meshProgram(stateDir: string, entry = Bun.main): string {
  if (!entry.endsWith(".ts")) return process.execPath;
  const path = join(stateDir, LAUNCHER);
  const text = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text, { mode: 0o700 });
  return path;
}
