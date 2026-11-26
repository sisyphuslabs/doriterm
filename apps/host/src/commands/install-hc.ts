import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";
import { HcInstallError, installHc } from "../hc-install.ts";

/** `doriface-host --install-hc`: installs (or updates) herdr-core from its checksummed release, then says where. */
export async function installHerdrCore(out: (text: string) => void, log: (line: string) => void): Promise<void> {
  const env = process.env;
  const installing = installHc({ home: homedir(), env, onPhase: (phase) => log(`installing herdr-core: ${phase}`) });
  // A failed install is no refused command line: its cause, never the usage.
  const installed = await installing.catch((error: unknown) => {
    if (!(error instanceof HcInstallError)) throw error;
    process.stderr.write(`doriface-host --install-hc: ${error.message}\n`);
    return undefined;
  });
  if (installed === undefined) {
    process.exitCode = 1;
    return;
  }
  out(`herdr-core ${installed.version} ${installed.action} at ${installed.path}\n`);
  const dir = dirname(installed.path);
  if (!(env["PATH"] ?? "").split(delimiter).includes(dir)) {
    out(`Add ${dir} to your PATH, or pass --hc ${installed.path}.\n`);
  }
}
