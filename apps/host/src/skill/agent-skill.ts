import type { SkillDirStatus, SkillState, SkillStatus } from "@doriface/protocol";
import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "../self-update/manifest.ts";
import { isRecord } from "../state/files.ts";
import type { SkillFile } from "./bundle-macro.ts";
import { withSkillLock, writeSkillDir } from "./skill-write.ts";

/** The skill's directory name in every agent skill directory, which is also its `name` in SKILL.md. */
export const SKILL_NAME = "doriterm";

/** The file a host writes beside the skill: which host version wrote it, and what it wrote. */
export const MARKER_FILE = ".doriface-host.json";

const WRITER = "doriface-host";

export interface SkillBundle {
  readonly version: string;
  readonly files: readonly SkillFile[];
}

/** One agent skill directory: where it is, and how the host shows it (`~/.agents/skills`). */
export interface SkillTarget {
  readonly path: string;
  readonly shown: string;
}

export type InstallAction = "written" | "updated" | "unchanged" | "foreign" | "failed";
export type UninstallAction = "removed" | "missing" | "foreign" | "failed";

export interface DirResult<A> {
  readonly dir: string;
  readonly action: A;
  /** Why it failed, for `failed`. */
  readonly error?: string;
}

interface Marker {
  readonly version: string;
  readonly digest: string;
}

/** The bundle's content, so a copy of the same version written by another build (a dev checkout) reads as outdated. */
export function bundleDigest(files: readonly SkillFile[]): string {
  const hash = createHash("sha256");
  for (const file of files.toSorted((a, b) => (a.path < b.path ? -1 : 1))) hash.update(`${file.path}\0${file.text}\0`);
  return hash.digest("hex");
}

/** What is at `<dir>/doriterm`: nothing, a real directory, or something else (a symlink or a file), which is foreign. */
async function entryKind(path: string): Promise<"none" | "dir" | "other"> {
  try {
    const entry = await lstat(path);
    return entry.isDirectory() ? "dir" : "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "none";
    throw error;
  }
}

async function readMarker(skillDir: string): Promise<Marker | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(skillDir, MARKER_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["writer"] !== WRITER) return undefined;
  const { version, digest } = value;
  return typeof version === "string" && typeof digest === "string" ? { version, digest } : undefined;
}

interface Found {
  readonly state: SkillState;
  readonly version?: string;
}

async function find(bundle: SkillBundle, target: SkillTarget): Promise<Found> {
  const skillDir = join(target.path, SKILL_NAME);
  const kind = await entryKind(skillDir);
  if (kind === "none") return { state: "missing" };
  const marker = kind === "dir" ? await readMarker(skillDir) : undefined;
  if (marker === undefined) return { state: "foreign" };
  const order = compareVersions(marker.version, bundle.version);
  // A newer host's copy is left as it is: a host never takes the skill back to an older version.
  const current =
    order > 0 || bundle.files.length === 0 || (order === 0 && marker.digest === bundleDigest(bundle.files));
  return { state: current ? "installed" : "outdated", version: marker.version };
}

const dirStatus = (target: SkillTarget, found: Found): SkillDirStatus =>
  found.version === undefined
    ? { dir: target.shown, state: found.state }
    : { dir: target.shown, state: found.state, version: found.version };

export async function skillStatus(bundle: SkillBundle, targets: readonly SkillTarget[]): Promise<SkillStatus> {
  const dirs = await Promise.all(targets.map(async (target) => dirStatus(target, await find(bundle, target))));
  return { bundled: bundle.files.length === 0 ? null : bundle.version, dirs };
}

const markerOf = (bundle: SkillBundle, installedAt: Date) => ({
  file: MARKER_FILE,
  text: `${JSON.stringify(
    {
      writer: WRITER,
      version: bundle.version,
      digest: bundleDigest(bundle.files),
      installedAt: installedAt.toISOString(),
    },
    null,
    2,
  )}\n`,
});

const failed = <A>(dir: string, error: unknown): DirResult<A | "failed"> => ({
  dir,
  action: "failed",
  error: error instanceof Error ? error.message : String(error),
});

export class NoBundledSkill extends Error {
  override readonly name = "NoBundledSkill";
  constructor() {
    super("this doriface-host build carries no agent skill");
  }
}

async function installOne(
  bundle: SkillBundle,
  target: SkillTarget,
  now: () => Date,
  outdatedOnly: boolean,
): Promise<DirResult<InstallAction>> {
  const { state } = await find(bundle, target);
  if (state === "foreign") return { dir: target.shown, action: "foreign" };
  const write = state === "outdated" || (state === "missing" && !outdatedOnly);
  if (!write) return { dir: target.shown, action: "unchanged" };
  await writeSkillDir(target.path, SKILL_NAME, bundle.files, markerOf(bundle, now()), state === "outdated");
  return { dir: target.shown, action: state === "outdated" ? "updated" : "written" };
}

/**
 * Installs the bundled skill where it is missing and updates a copy an older host wrote; `outdatedOnly` updates and
 * writes nothing new (what a host does after it updated itself). A foreign copy is never touched. Each directory is
 * tried on its own: one that fails is reported `failed` and the others still are written.
 */
export async function installSkill(
  bundle: SkillBundle,
  targets: readonly SkillTarget[],
  now: () => Date,
  outdatedOnly = false,
): Promise<readonly DirResult<InstallAction>[]> {
  if (bundle.files.length === 0) throw new NoBundledSkill();
  const results: DirResult<InstallAction>[] = [];
  for (const target of targets) {
    const attempt = installOne(bundle, target, now, outdatedOnly);
    // oxlint-disable-next-line no-await-in-loop -- one directory after another, in the order they are reported
    results.push(await attempt.catch((error: unknown) => failed(target.shown, error)));
  }
  return results;
}

/** Removes the copies a host wrote, under the install lock; a foreign `doriterm` directory stays. */
export async function uninstallSkill(
  bundle: SkillBundle,
  targets: readonly SkillTarget[],
): Promise<readonly DirResult<UninstallAction>[]> {
  return Promise.all(
    targets.map(async (target): Promise<DirResult<UninstallAction>> => {
      try {
        if ((await entryKind(target.path)) === "none") return { dir: target.shown, action: "missing" };
        return await withSkillLock(target.path, SKILL_NAME, async (): Promise<DirResult<UninstallAction>> => {
          const { state } = await find(bundle, target);
          if (state === "missing" || state === "foreign") return { dir: target.shown, action: state };
          await rm(join(target.path, SKILL_NAME), { recursive: true, force: true });
          return { dir: target.shown, action: "removed" };
        });
      } catch (error) {
        return failed(target.shown, error);
      }
    }),
  );
}
