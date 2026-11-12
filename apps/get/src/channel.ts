import type { ReleaseBucket } from "./bindings.ts";
import { type Channel, compareVersions, isVersion, pointerKey, yankedKey } from "./names.ts";

/** `channels/<channel>.json`, the only object a release moves (#1969). */
export interface Pointer {
  readonly version: string;
  readonly previous?: string;
  /** The percentage of installs offered this version, 0 to 100. */
  readonly rollout: number;
  /** The lowest version that can still update itself to this one. */
  readonly minimum?: string;
  readonly publishedAt: string;
}

/** What a channel offers right now: a yanked version is never named, so its pointer falls back to `previous`. */
export interface Resolved {
  /** The pointer that won: beta follows stable when stable is newer. */
  readonly channel: Channel;
  readonly version: string;
  readonly rollout: number;
  readonly minimum?: string;
}

export function parsePointer(text: string): Pointer | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== "object" || value === null) return null;
  const field = (name: string): unknown => Reflect.get(value, name);
  const version = field("version");
  const previous = field("previous");
  const rollout = field("rollout");
  const minimum = field("minimum");
  const publishedAt = field("publishedAt");
  if (typeof version !== "string" || !isVersion(version)) return null;
  if (previous !== undefined && (typeof previous !== "string" || !isVersion(previous))) return null;
  if (minimum !== undefined && (typeof minimum !== "string" || !isVersion(minimum))) return null;
  if (typeof rollout !== "number" || !Number.isInteger(rollout) || rollout < 0 || rollout > 100) return null;
  if (typeof publishedAt !== "string") return null;
  return {
    version,
    rollout,
    publishedAt,
    ...(previous === undefined ? {} : { previous }),
    ...(minimum === undefined ? {} : { minimum }),
  };
}

export async function readPointer(bucket: ReleaseBucket, channel: Channel): Promise<Pointer | null> {
  const object = await bucket.get(pointerKey(channel));
  return object === null ? null : parsePointer(await object.text());
}

const isYanked = async (bucket: ReleaseBucket, version: string): Promise<boolean> =>
  (await bucket.head(yankedKey(version))) !== null;

async function offered(bucket: ReleaseBucket, channel: Channel): Promise<Resolved | null> {
  const pointer = await readPointer(bucket, channel);
  if (pointer === null) return null;
  if (!(await isYanked(bucket, pointer.version))) {
    return {
      channel,
      version: pointer.version,
      rollout: pointer.rollout,
      ...(pointer.minimum === undefined ? {} : { minimum: pointer.minimum }),
    };
  }
  // A yank without a rollback: the version before it was fully rolled out, so it is offered to everyone again.
  const { previous, minimum } = pointer;
  if (previous === undefined || (await isYanked(bucket, previous))) return null;
  const floor = minimum !== undefined && compareVersions(minimum, previous) <= 0 ? { minimum } : {};
  return { channel, version: previous, rollout: 100, ...floor };
}

/** The version a channel offers, or null before its first mirror (or when every version it could name is yanked). */
export async function resolveChannel(bucket: ReleaseBucket, channel: Channel): Promise<Resolved | null> {
  const stable = await offered(bucket, "stable");
  if (channel === "stable") return stable;
  const beta = await offered(bucket, "beta");
  if (beta === null || stable === null) return beta ?? stable;
  return compareVersions(beta.version, stable.version) >= 0 ? beta : stable;
}
