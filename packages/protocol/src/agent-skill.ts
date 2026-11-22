import { isJsonObject, type JsonValue } from "./json.ts";

/**
 * Where the Doriterm agent skill stands in one agent skill directory: `installed` is a copy this host build wrote (or a
 * newer host's), `outdated` one an older host wrote, `missing` none, and `foreign` a `doriterm` directory no host wrote,
 * which a host never overwrites or removes.
 */
export type SkillState = "installed" | "outdated" | "missing" | "foreign";

export type SkillDirStatus = {
  /** The agent skill directory, as the host shows it (`~/.agents/skills`). */
  readonly dir: string;
  readonly state: SkillState;
  /** The host version that wrote the copy, for `installed` and `outdated`. */
  readonly version?: string;
};

/** What a host reports about the agent skill, in its `doriface-host` document and from `skill status --json`. */
export type SkillStatus = {
  /** The skill version this host build carries (the host's version), or null when the build carries none. */
  readonly bundled: string | null;
  readonly dirs: readonly SkillDirStatus[];
};

const STATES: ReadonlySet<string> = new Set<SkillState>(["installed", "outdated", "missing", "foreign"]);

const isSkillState = (value: unknown): value is SkillState => typeof value === "string" && STATES.has(value);

function parseDir(value: JsonValue): SkillDirStatus | undefined {
  if (!isJsonObject(value)) return undefined;
  const { dir, state, version } = value;
  if (typeof dir !== "string" || !isSkillState(state)) return undefined;
  if (version !== undefined && typeof version !== "string") return undefined;
  return version === undefined ? { dir, state } : { dir, state, version };
}

/** A skill status as a host wrote it, or undefined for any other shape. */
export function parseSkillStatus(value: JsonValue | undefined): SkillStatus | undefined {
  if (value === undefined || !isJsonObject(value)) return undefined;
  const { bundled, dirs } = value;
  if (bundled !== null && typeof bundled !== "string") return undefined;
  if (!Array.isArray(dirs)) return undefined;
  const parsed = dirs.map(parseDir);
  if (!parsed.every((dir) => dir !== undefined)) return undefined;
  return { bundled, dirs: parsed.filter((dir) => dir !== undefined) };
}

/**
 * The document a client writes on a machine's core to ask that machine's host to install (or update) the agent skill:
 * `{request}`, which the host answers in place with `done` (and the status after it) or `error`. Anyone who can write a
 * core's documents already reaches its shells, so the request grants no more than they hold.
 */
export const SKILL_REQUEST_DOC = "doriface-skill";

export type SkillRequestDoc =
  | { readonly request: string }
  | { readonly request: string; readonly done: SkillStatus }
  | { readonly request: string; readonly error: string };

/** The request document as written, or undefined for anything else. */
export function parseSkillRequestDoc(value: JsonValue): SkillRequestDoc | undefined {
  if (!isJsonObject(value)) return undefined;
  const { request, done, error } = value;
  if (typeof request !== "string" || request === "") return undefined;
  if (typeof error === "string") return { request, error };
  if (done !== undefined) {
    const status = parseSkillStatus(done);
    return status === undefined ? undefined : { request, done: status };
  }
  return { request };
}
