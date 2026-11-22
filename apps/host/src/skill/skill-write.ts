import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillFile } from "./bundle-macro.ts";

const errorCode = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
};

/**
 * Takes `<skills dir>/.<name>.lock`, a file holding the writer's pid, so two writers (the installer's CLI, the running
 * host after a self-update, a request from the app) never swap the same directory at once. A lock whose writer is gone
 * (a crash) is taken over; a live one refuses at once rather than waiting.
 */
async function lock(dir: string, name: string): Promise<() => Promise<void>> {
  const path = join(dir, `.${name}.lock`);
  for (const attempt of [1, 2]) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the second attempt runs only after a stale lock was removed
      await writeFile(path, String(process.pid), { flag: "wx" });
      return () => rm(path, { force: true });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      // oxlint-disable-next-line no-await-in-loop -- as above
      const holder = Number(await readFile(path, "utf8").catch(() => ""));
      if (attempt === 2 || (Number.isInteger(holder) && holder > 0 && alive(holder))) {
        throw new Error(`another install of the ${name} skill is running in ${dir}`, { cause: error });
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      await rm(path, { force: true });
    }
  }
  throw new Error("unreachable");
}

/** Runs `run` holding the lock on `<dir>/<name>`, so an install and an uninstall never meet halfway. */
export async function withSkillLock<T>(dir: string, name: string, run: () => Promise<T>): Promise<T> {
  const unlock = await lock(dir, name);
  try {
    return await run();
  } finally {
    await unlock();
  }
}

/** Staging directories an install that crashed left beside the skill; only swept while the lock is held. */
async function sweepStaging(dir: string, name: string): Promise<void> {
  const prefix = `.${name}.new-`;
  const stale = (await readdir(dir)).filter((entry) => entry.startsWith(prefix));
  await Promise.all(stale.map((entry) => rm(join(dir, entry), { recursive: true, force: true })));
}

/**
 * Writes `files` and `marker` into a staging directory beside `<dir>/<name>` and renames it into place, so an agent
 * never reads a partial copy: an old copy is moved aside first and removed once the new one is in.
 */
export async function writeSkillDir(
  dir: string,
  name: string,
  files: readonly SkillFile[],
  marker: { readonly file: string; readonly text: string },
  hasCopy: boolean,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await withSkillLock(dir, name, async () => {
    await sweepStaging(dir, name);
    const staging = await mkdtemp(join(dir, `.${name}.new-`));
    await chmod(staging, 0o755);
    const skillDir = join(dir, name);
    const aside = `${staging}.old`;
    let moved = false;
    try {
      for (const file of files) {
        const path = join(staging, ...file.path.split("/"));
        // oxlint-disable-next-line no-await-in-loop -- a handful of small files, each directory made before its file
        await mkdir(dirname(path), { recursive: true });
        // oxlint-disable-next-line no-await-in-loop -- as above
        await writeFile(path, file.text);
      }
      await writeFile(join(staging, marker.file), marker.text);
      if (hasCopy) {
        await rename(skillDir, aside);
        moved = true;
      }
      await rename(staging, skillDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (moved) await rename(aside, skillDir).catch(() => undefined);
      throw error;
    }
    if (moved) await rm(aside, { recursive: true, force: true });
  });
}
