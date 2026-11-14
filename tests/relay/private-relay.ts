/**
 * The relay server is deployed separately, from its own private repository; its public contract is
 * docs/transport.md. The suites in this directory run this repository's host and client against it, at the commit
 * `relay-pin.json` names, from a checkout this module keeps:
 *
 *   bun run relay:fetch   clone or move `.relay` to the pinned commit and install it
 *   bun run relay:test    fetch, then run the relay suites
 *   bun run relay:dev     fetch, then serve the relay locally with wrangler dev
 *
 * `RELAY_REPO` names that repository as `owner/name`; it is cloned over HTTPS with your git credentials. CI reads it
 * from a repository secret, so the log masks it, and gives git a read-only token through a credential helper.
 * `DORIFACE_RELAY_REPO` overrides the whole clone URL instead, e.g. for SSH.
 * `DORIFACE_RELAY_DIR` points at a relay checkout of your own instead, which is used as it is and never moved.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MANAGED_DIR = resolve(REPO_ROOT, ".relay");

interface RelayPin {
  readonly rev: string;
}

/** The relay checkout the suites and `relay:dev` use. */
export const relayDir = (): string => process.env["DORIFACE_RELAY_DIR"] ?? MANAGED_DIR;

class RelayUnreachable extends Error {}

/** Neither `RELAY_REPO` nor `DORIFACE_RELAY_REPO` says where the relay lives. */
class RelaySourceUnset extends Error {}

/** `.relay` holds something that is not a repository of its own; it is left exactly as found. */
class RelayCheckoutInvalid extends Error {}

/** The exit code of that refusal, distinct from a crash or a git error (1) and a usage error (2). */
const REFUSED_EXIT = 3;

async function readPin(): Promise<RelayPin> {
  const pin: unknown = await Bun.file(join(REPO_ROOT, "relay-pin.json")).json();
  if (
    typeof pin !== "object" ||
    pin === null ||
    !("rev" in pin) ||
    typeof pin.rev !== "string" ||
    !/^[0-9a-f]{40}$/.test(pin.rev)
  ) {
    throw new Error("relay-pin.json must be {rev} with rev a full commit id");
  }
  return { rev: pin.rev };
}

/** The clone URL: `DORIFACE_RELAY_REPO` as given, else HTTPS for `RELAY_REPO` (`owner/name`). */
function relaySource(): string {
  const url = process.env["DORIFACE_RELAY_REPO"];
  if (url) return url;
  const slug = process.env["RELAY_REPO"];
  if (!slug) throw new RelaySourceUnset();
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error("RELAY_REPO must be owner/name");
  return `https://github.com/${slug}.git`;
}

/**
 * Variables that point git at a repository, index or object store (`git rev-parse --local-env-vars`). A hook or
 * `git rebase -x` in a linked worktree exports an absolute GIT_DIR, and a pre-commit hook a GIT_INDEX_FILE; passed on,
 * they would send every forced step below into the public checkout that runs this script.
 */
async function repositoryVariables(): Promise<ReadonlySet<string>> {
  const proc = Bun.spawn(["git", "rev-parse", "--local-env-vars"], { stdout: "pipe", stderr: "ignore" });
  const listed = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
  if ((await proc.exited) !== 0 || !listed.includes("GIT_DIR"))
    throw new Error("git rev-parse --local-env-vars failed");
  return new Set(listed);
}

type Env = Record<string, string | undefined>;

// A credential prompt would hang CI and confuse a developer without access; fail instead.
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

/**
 * The environment for git in the managed checkout, and nowhere else: the caller's repository variables are dropped,
 * and GIT_DIR and GIT_WORK_TREE name `.relay` explicitly, so git never discovers a repository on its own.
 *
 * GIT_CONFIG_* stays, since CI's credential helper lives there. So does the caller's own git config: a `core.hooksPath`
 * or `core.fsmonitor` there can run code during the fetch, but only code the caller already runs with the same
 * privileges in every repository of theirs, so it is not narrowed to the credential helper entry.
 */
function confinedTo(dir: string, repository: ReadonlySet<string>): Env {
  const kept = Object.entries(process.env).filter(([name]) => !repository.has(name) || name.startsWith("GIT_CONFIG"));
  return { ...Object.fromEntries(kept), GIT_DIR: join(dir, ".git"), GIT_WORK_TREE: dir, ...NO_PROMPT };
}

/** A variable that may carry a credential: any `*TOKEN*`, and git config passed in the environment (`GIT_CONFIG_*`). */
const isCredential = (name: string): boolean => name.includes("TOKEN") || name.startsWith("GIT_CONFIG_");

/**
 * The environment for the relay's `bun install`: none of the caller's repository variables, so its lifecycle scripts'
 * git finds `.relay` itself, and none of the credentials the fetch used.
 */
function installEnv(repository: ReadonlySet<string>): Env {
  const kept = Object.entries(process.env).filter(([name]) => !repository.has(name) && !isCredential(name));
  return { ...Object.fromEntries(kept), ...NO_PROMPT };
}

/** Runs `argv` in `cwd` with stdout passed through; stderr is returned as well as printed. */
async function run(argv: readonly string[], cwd: string, env: Env): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "inherit", stderr: "pipe", env });
  const stderr = await new Response(proc.stderr).text();
  process.stderr.write(stderr);
  return { code: await proc.exited, stderr };
}

async function must(argv: readonly string[], cwd: string, env: Env): Promise<void> {
  const { code } = await run(argv, cwd, env);
  if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code} in ${cwd}`);
}

async function gitOutput(dir: string, env: Env, args: readonly string[]): Promise<string | undefined> {
  const proc = Bun.spawn(["git", ...args], { cwd: dir, env, stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 ? out : undefined;
}

/** What is at `path` itself, without following a symlink. */
function kindOf(path: string): "missing" | "directory" | "other" {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * True when anything under `dir` is a symlink. It reads each directory without following links (a dirent's type is
 * the entry's own), descends only into real directories and stops at the first link, so a link into a huge tree or a
 * link loop costs nothing.
 */
function holdsSymlink(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && holdsSymlink(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * True only when the real directory `dir` (the caller checked it) holds a `.git` that is a real directory with its own
 * store and nothing linked out of it: a symlinked `.git`, a `gitdir:` file, a `commondir` into another repository, or
 * any symlink inside `.git` (an `objects/` or `index` borrowed from another repository, as `git-new-workdir` lays out)
 * would let git write somewhere else. git itself never creates symlinks there. GIT_DIR is explicit, so git's own idea
 * of the git dir is always `.git`; only where its store lives (the common dir) can differ.
 */
async function ownsRepository(dir: string, env: Env): Promise<boolean> {
  const gitDir = join(dir, ".git");
  if (kindOf(gitDir) !== "directory") return false;
  if (holdsSymlink(gitDir)) return false;
  const common = await gitOutput(dir, env, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common === realpathSync(gitDir);
}

/** Brings the managed checkout to the pinned commit and installs it; returns the relay directory to use. */
export async function fetchRelay(): Promise<string> {
  const dir = relayDir();
  if (dir !== MANAGED_DIR) {
    console.log(`relay: using DORIFACE_RELAY_DIR=${dir} as it is`);
    return dir;
  }
  const pin = await readPin();
  const repository = await repositoryVariables();
  const env = confinedTo(dir, repository);
  // A checkout already at the pin needs no source; a fresh one finds out it has none before `.relay` exists.
  let url: string | undefined;
  if (kindOf(dir) === "missing") {
    url = relaySource();
    await mkdir(dir);
  }
  // The only check of `.relay` itself: through a symlink, the forced checkout below would land on wherever it points.
  if (kindOf(dir) !== "directory") throw new RelayCheckoutInvalid(dir);
  if (kindOf(join(dir, ".git")) === "missing") await must(["git", "init", "--quiet"], dir, env);
  if (!(await ownsRepository(dir, env))) throw new RelayCheckoutInvalid(dir);
  if ((await gitOutput(dir, env, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== pin.rev) {
    url ??= relaySource();
    const fetched = await run(["git", "fetch", "--quiet", "--depth", "1", url, pin.rev], dir, env);
    if (fetched.code !== 0) throw new RelayUnreachable(`the relay at ${pin.rev}`);
    await must(["git", "checkout", "--quiet", "--detach", "--force", "FETCH_HEAD"], dir, env);
  }
  // The checkout is this module's own: discard what `bun install` changes inside the submodule (it marks the vendored
  // host CLI executable), or moving to a new pin would refuse to switch the submodule.
  await must(["git", "submodule", "update", "--init", "--depth", "1", "--force"], dir, env);
  await must([process.execPath, "install", "--frozen-lockfile"], dir, installEnv(repository));
  console.log(`relay: ${pin.rev} in ${dir}`);
  return dir;
}

async function main(command: string | undefined, rest: readonly string[]): Promise<number> {
  if (command === "notice") {
    console.log(
      "tests/relay skipped: the relay suites need the private relay; run `bun run relay:test` to fetch it and run them.",
    );
    return 0;
  }
  if (command !== "fetch" && command !== "test" && command !== "dev") {
    console.error("usage: bun tests/relay/private-relay.ts fetch|test|dev|notice [args]");
    return 2;
  }
  const dir = await fetchRelay();
  if (command === "fetch") return 0;
  const argv =
    command === "test"
      ? // bunfig.toml keeps tests/relay out of a plain `bun test`; a pattern given here replaces that list.
        [process.execPath, "test", "--path-ignore-patterns", ".relay/**", "./tests/relay", ...rest]
      : [join(dir, "node_modules", ".bin", "wrangler"), "dev", ...rest];
  const proc = Bun.spawn(argv, {
    cwd: command === "test" ? REPO_ROOT : dir,
    stdio: ["inherit", "inherit", "inherit"],
    env: relaySpawnEnv(dir, process.env),
  });
  return proc.exited;
}

// Release builds name it bun-node-<uid>-<hash>; a Bun built without a commit hash makes a bare bun-node.
const isBunNodeShim = (name: string): boolean => name === "bun-node" || name.startsWith("bun-node-");

/**
 * `env` with the directory `bunx --bun` puts first on PATH left out: its `node` is bun, and wrangler run under bun never
 * gets the relay up (#2327). Every process a `bunx --bun playwright test` worker spawns inherits that PATH. It lives here
 * because this script runs on its own, before any install (tests/relay-fetch copies it alone).
 */
export function withoutBunNodeShim(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const path = env["PATH"];
  if (path === undefined) return { ...env };
  const kept = path.split(delimiter).filter((dir) => !isBunNodeShim(basename(dir)));
  return { ...env, PATH: kept.join(delimiter) };
}

/** The env relay:dev and relay:test start their child with: the relay checkout named, and no bun-node shim (#2346). */
export function relaySpawnEnv(
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return withoutBunNodeShim({ ...env, DORIFACE_RELAY_DIR: dir });
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv[2], process.argv.slice(3));
  } catch (error) {
    if (error instanceof RelayCheckoutInvalid) {
      console.error(`
relay: ${error.message} is not a git checkout of its own, so relay:fetch leaves it alone. Move it aside or delete
it (rm -rf .relay), then run \`bun run relay:fetch\` again to clone the relay afresh.`);
      process.exitCode = REFUSED_EXIT;
    } else if (error instanceof RelaySourceUnset || error instanceof RelayUnreachable) {
      const what =
        error instanceof RelaySourceUnset
          ? "RELAY_REPO is not set, so there is no relay repository to fetch"
          : `Could not fetch ${error.message}`;
      console.error(`
${what}.

The relay server is deployed separately, from its own private repository. Its public contract is docs/transport.md.
Without access, \`bun run check\` still runs every other suite; only the relay suites in tests/relay need this
checkout. With access, set RELAY_REPO=<owner>/<name>, let git reach the repository (\`gh auth setup-git\`, or
DORIFACE_RELAY_REPO=<ssh clone URL> for SSH) and run \`bun run relay:fetch\` again.`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
