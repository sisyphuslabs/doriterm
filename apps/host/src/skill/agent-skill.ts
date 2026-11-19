import type { SkillDirStatus, SkillState, SkillStatus } from "@doriface/protocol";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareVersions } from "../self-update/manifest.ts";
import { isRecord } from "../state/files.ts";
import type { SkillFile } from "./bundle-macro.ts";

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

export type InstallAction = "written" | "updated" | "unchanged" | "foreign";
export type UninstallAction = "removed" | "missing" | "foreign";

export interface DirResult<A> {
  readonly dir: string;
  readonly action: A;
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

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

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
  if (!(await exists(skillDir))) return { state: "missing" };
  const marker = await readMarker(skillDir);
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

/**
 * Writes the bundle into a temporary directory beside the skill and renames it into place, so an agent reading the
 * skill sees the old copy or the new one, never half of one. An old copy is moved aside first and removed after.
 */
async function writeAtomically(bundle: SkillBundle, target: SkillTarget, installedAt: Date): Promise<void> {
  await mkdir(target.path, { recursive: true });
  const staging = await mkdtemp(join(target.path, `.${SKILL_NAME}.new-`));
  const skillDir = join(target.path, SKILL_NAME);
  let aside: string | undefined;
  try {
    for (const file of bundle.files) {
      const path = join(staging, ...file.path.split("/"));
      // oxlint-disable-next-line no-await-in-loop -- a handful of small files, each directory made before its file
      await mkdir(dirname(path), { recursive: true });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await writeFile(path, file.text);
    }
    const marker = {
      writer: WRITER,
      version: bundle.version,
      digest: bundleDigest(bundle.files),
      installedAt: installedAt.toISOString(),
    };
    await writeFile(join(staging, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
    if (await exists(skillDir)) {
      aside = `${staging}.old`;
      await rename(skillDir, aside);
    }
    await rename(staging, skillDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (aside !== undefined && !(await exists(skillDir))) await rename(aside, skillDir);
    throw error;
  }
  if (aside !== undefined) await rm(aside, { recursive: true, force: true });
}

export class NoBundledSkill extends Error {
  override readonly name = "NoBundledSkill";
  constructor() {
    super("this doriface-host build carries no agent skill");
  }
}

/**
 * Installs the bundled skill where it is missing and updates a copy an older host wrote; `outdatedOnly` updates and
 * writes nothing new (what a host does after it updated itself). A foreign copy is never touched.
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
    // oxlint-disable-next-line no-await-in-loop -- one directory after another, so a failure names where it stopped
    const { state } = await find(bundle, target);
    const write = state === "outdated" || (state === "missing" && !outdatedOnly);
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (write) await writeAtomically(bundle, target, now());
    const action: InstallAction =
      state === "foreign" ? "foreign" : !write ? "unchanged" : state === "outdated" ? "updated" : "written";
    results.push({ dir: target.shown, action });
  }
  return results;
}

/** Removes the copies a host wrote; a foreign `doriterm` directory stays. */
export async function uninstallSkill(
  bundle: SkillBundle,
  targets: readonly SkillTarget[],
): Promise<readonly DirResult<UninstallAction>[]> {
  return Promise.all(
    targets.map(async (target): Promise<DirResult<UninstallAction>> => {
      const { state } = await find(bundle, target);
      if (state === "missing" || state === "foreign") return { dir: target.shown, action: state };
      await rm(join(target.path, SKILL_NAME), { recursive: true, force: true });
      return { dir: target.shown, action: "removed" };
    }),
  );
}
