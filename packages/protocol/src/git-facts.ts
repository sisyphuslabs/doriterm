import type { JsonValue } from "./json.ts";

/** The herdr document a doriface-host keeps on its own core: the git state of each directory its terminals sit in. */
export const GIT_FACTS_DOC = "doriface-git";

/** How often the host writes the facts again; the page reads them on its own cadence. */
export const GIT_FACTS_WRITE_MS = 5_000;
/** The longest a `git status` may run before the host kills it. */
export const GIT_FACTS_TIMEOUT_MS = 5_000;
/** How often the page reads the facts again; the host writes them on its own cadence. */
export const GIT_FACTS_READ_MS = 5_000;

export interface GitFacts {
  /** The branch checked out; absent when HEAD is detached. */
  readonly branch?: string;
  readonly detached: boolean;
  /** Whether the branch is the repository's default one (origin's HEAD, else `main` or `master`). */
  readonly onDefault: boolean;
  /** Commits on the branch that its upstream lacks, and the other way round; both zero without an upstream. */
  readonly ahead: number;
  readonly behind: number;
  /** Changed, staged or untracked files. */
  readonly dirty: boolean;
}

export interface GitFactsDoc {
  readonly v: 1;
  /** Keyed by the directory as the core reports it (a terminal's foreground cwd, else its cwd). */
  readonly dirs: Readonly<Record<string, GitFacts>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

function parseFacts(value: unknown): GitFacts | undefined {
  if (!isRecord(value)) return undefined;
  const { branch, detached, onDefault, ahead, behind, dirty } = value;
  const aheadCount = count(ahead);
  const behindCount = count(behind);
  if (typeof detached !== "boolean" || typeof onDefault !== "boolean" || typeof dirty !== "boolean") return undefined;
  if (aheadCount === undefined || behindCount === undefined) return undefined;
  if (branch !== undefined && typeof branch !== "string") return undefined;
  const facts = { detached, onDefault, ahead: aheadCount, behind: behindCount, dirty };
  return branch === undefined ? facts : { branch, ...facts };
}

/** The document's facts, leaving out any entry this version cannot read; undefined for another version or no document. */
export function parseGitFacts(value: JsonValue): GitFactsDoc | undefined {
  if (!isRecord(value) || value["v"] !== 1 || !isRecord(value["dirs"])) return undefined;
  const dirs: Record<string, GitFacts> = {};
  for (const [dir, entry] of Object.entries(value["dirs"])) {
    const facts = parseFacts(entry);
    if (facts !== undefined) dirs[dir] = facts;
  }
  return { v: 1, dirs };
}
