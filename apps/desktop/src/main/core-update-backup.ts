import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The release files `hc update --from` needs, including platform companions. */
export async function backupCore(binary: string, platform: NodeJS.Platform) {
  const directory = await mkdtemp(join(tmpdir(), "doriterm-hc-rollback-"));
  const executable = join(directory, basename(binary));
  try {
    if (platform === "darwin") {
      const bundle = dirname(dirname(dirname(await realpath(binary))));
      const backup = join(directory, "Herdr Core.app");
      await cp(bundle, backup, { recursive: true, verbatimSymlinks: true });
      return { directory, executable: join(backup, "Contents", "MacOS", "herdr-core") };
    }
    await cp(binary, executable);
    if (platform === "win32") {
      await cp(join(dirname(binary), "conpty"), join(directory, "conpty"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    return { directory, executable };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
