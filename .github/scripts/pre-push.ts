/**
 * The pre-push hook (.husky/pre-push; husky activates it on `bun install`) runs `bun run check:fast`, the typecheck,
 * lint, format and API codegen checks, before a push leaves the machine. The `Check` job runs the same script, so the
 * two cannot drift (tests/ci/pre-push.test.ts pins both). Between 2026-11-07 and 2026-11-21, 5 of the 12 failed `Check`
 * runs failed on lint or format, each a few seconds locally. The test suite stays with CI: it takes minutes.
 *
 * The changelog check is not here: its fragment is named after the pull request's number, which the first push of a
 * branch cannot know, and the `no-changelog` label it honours lives on the pull request.
 */

const ZERO_SHA = /^0+$/;

export const FAST_CHECK = "bun run check:fast";

/**
 * The commits a push sends to branches, from the hook's stdin (`<local ref> <local sha> <remote ref> <remote sha>` per
 * line). Tags are not branch work and are not judged; a deletion sends no commit.
 */
export function pushedBranchCommits(refs: string): string[] {
  return refs.split("\n").flatMap((line) => {
    const [, sha = "", remoteRef = ""] = line.trim().split(/\s+/);
    return remoteRef.startsWith("refs/heads/") && !ZERO_SHA.test(sha) ? [sha] : [];
  });
}

/** Why the working tree is not what is pushed, so the checks cannot judge it; `undefined` when it is. */
export function pushRefusal(pushed: readonly string[], head: string, dirty: boolean): string | undefined {
  if (pushed.some((sha) => sha !== head)) {
    return "the pushed commit is not HEAD; check it out and push again so the checks judge what is pushed";
  }
  if (dirty) return "tracked files have uncommitted changes; commit or stash them so the checks judge what is pushed";
  return undefined;
}

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
  return output.trim();
}

function refuse(reason: string): never {
  console.error(`pre-push: refused: ${reason}`);
  process.exit(1);
}

if (import.meta.main) {
  const [refs, head, status] = await Promise.all([
    Bun.stdin.text(),
    git("rev-parse", "HEAD"),
    git("status", "--porcelain", "--untracked-files=no"),
  ]);
  const pushed = pushedBranchCommits(refs);
  if (pushed.length > 0) {
    const refusal = pushRefusal(pushed, head, status !== "");
    if (refusal !== undefined) refuse(refusal);
    console.error(`pre-push: ${FAST_CHECK}`);
    const code = await Bun.spawn(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", FAST_CHECK], {
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
    if (code !== 0) refuse(`${FAST_CHECK} failed (exit ${code}); the Check job runs the same script`);
    console.error(`pre-push: ${FAST_CHECK} passed`);
  }
}
