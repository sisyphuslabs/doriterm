// Runs `doriface-host skill <action>` under an e2e host's own HOME and state dir, which tells that running host, so a
// spec starts from the skill state it names whatever ran before it (a retry, or another spec).
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readSavedEnv } from "./saved-env.ts";

const run = promisify(execFile);

/** `savedFile` is the host's saved environment: E2E_HOST_ENV for this computer, MACHINE_ENV for the added machine. */
export async function skillOnHost(savedFile: string, action: "install" | "uninstall"): Promise<void> {
  const { env } = readSavedEnv(savedFile);
  const state = env["XDG_STATE_HOME"];
  if (state === undefined) throw new Error(`${savedFile} names no state dir`);
  const cli = join(import.meta.dirname, "..", "..", "host", "src", "cli.ts");
  await run("bun", [cli, "skill", action], { env: { ...process.env, ...env, HOME: join(dirname(state), "home") } });
}
