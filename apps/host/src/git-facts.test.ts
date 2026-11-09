import { HcRpcError, type JsonValue } from "@doriface/protocol";
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectGitFacts,
  dirsOf,
  GIT_TIMED_OUT,
  type GitFactsMemory,
  KEEP_TIMED_OUT_TICKS,
  parseStatus,
  publishGitFacts,
  readGitFacts,
  type RunGit,
  writeGitFacts,
} from "./git-facts.ts";

const root = mkdtempSync(join(tmpdir(), "git-facts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

function repo(name: string, branch = "main"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  writeFileSync(join(dir, "README"), "x\n");
  git(dir, "add", "README");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

describe("parseStatus", () => {
  test("a branch with an upstream, ahead and behind, and a changed file", () => {
    const text =
      "# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b f\n";
    expect(parseStatus(text)).toEqual({ branch: "feat/x", detached: false, ahead: 2, behind: 1, dirty: true });
  });

  test("a detached HEAD has no branch; a clean tree without an upstream is neither ahead nor behind", () => {
    expect(parseStatus("# branch.oid abc\n# branch.head (detached)\n")).toEqual({
      detached: true,
      ahead: 0,
      behind: 0,
      dirty: false,
    });
  });

  test("an untracked file makes the tree dirty", () => {
    expect(parseStatus("# branch.head main\n? new-file\n").dirty).toBe(true);
  });
});

describe("readGitFacts on real repositories", () => {
  test("a clean main is the default branch, in sync and clean", async () => {
    expect(await readGitFacts(repo("clean"))).toEqual({
      branch: "main",
      detached: false,
      onDefault: true,
      ahead: 0,
      behind: 0,
      dirty: false,
    });
  });

  test("a feature branch one commit ahead of its upstream, with an untracked file", async () => {
    const dir = repo("feature");
    git(dir, "checkout", "-q", "-b", "feat/rows");
    writeFileSync(join(dir, "change"), "1\n");
    git(dir, "add", "change");
    git(dir, "commit", "-q", "-m", "ahead");
    git(dir, "branch", "-q", "--set-upstream-to=main");
    writeFileSync(join(dir, "untracked"), "1\n");
    expect(await readGitFacts(dir)).toEqual({
      branch: "feat/rows",
      detached: false,
      onDefault: false,
      ahead: 1,
      behind: 0,
      dirty: true,
    });
  });

  test("origin's HEAD names the default branch: a `trunk` repository's main is not it", async () => {
    const upstream = repo("upstream", "trunk");
    const clone = join(root, "clone");
    git(root, "clone", "-q", upstream, clone);
    expect(await readGitFacts(clone)).toMatchObject({ onDefault: true });
    git(clone, "checkout", "-q", "-b", "main");
    expect(await readGitFacts(clone)).toMatchObject({ onDefault: false });
  });

  test("a detached HEAD", async () => {
    const dir = repo("detached");
    git(dir, "checkout", "-q", "--detach", "HEAD");
    expect(await readGitFacts(dir)).toMatchObject({ detached: true, onDefault: false });
  });

  test("a directory outside any repository has no facts", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect(await readGitFacts(plain)).toBeUndefined();
  });

  test("a repository's fsmonitor setting runs nothing, and reading takes no index lock", async () => {
    const dir = repo("hostile");
    const ran = join(root, "fsmonitor-ran");
    git(dir, "config", "core.fsmonitor", `touch ${ran}; false`);
    writeFileSync(join(dir, "README"), "changed\n");
    expect(await readGitFacts(dir)).toMatchObject({ dirty: true });
    expect(existsSync(ran)).toBe(false);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
  });
});

const terminal = (address: string, cwd: string, foreground?: string, state = "live") =>
  ({
    address,
    cwd,
    state,
    ...(foreground === undefined ? {} : { foreground: { cwd: foreground, argv: [], name: "sh", pid: 1 } }),
  }) as never;

/** A git that answers `status` in one directory and fails everywhere else. */
const statusOnlyIn =
  (repoDir: string) =>
  async (dir: string, args: readonly string[]): Promise<string | undefined> =>
    dir === repoDir && args[0] === "status" ? "# branch.head main\n" : undefined;

describe("dirsOf and collectGitFacts", () => {
  test("this core's live terminals only, by foreground cwd, each directory once", () => {
    const terminals = [
      terminal("t1", "/a", "/a/sub"),
      terminal("t2", "/b"),
      terminal("t3", "/b"),
      terminal("box/t4", "/c"),
      terminal("t5", "/d", undefined, "finished"),
    ];
    expect(dirsOf(terminals)).toEqual(["/a/sub", "/b"]);
  });

  test("collects the repositories and leaves the rest out", async () => {
    const run = statusOnlyIn("/repo");
    expect(await collectGitFacts(["/plain", "/repo"], run)).toEqual({
      v: 1,
      dirs: { "/repo": { branch: "main", detached: false, onDefault: true, ahead: 0, behind: 0, dirty: false } },
    });
  });
});

/** A git whose `status` in /repo answers, times out, or says "not a repository", as `answer` says this tick. */
function scripted(): { run: RunGit; answer: { now: "facts" | "timeout" | "no repo" } } {
  const answer = { now: "facts" as "facts" | "timeout" | "no repo" };
  const run: RunGit = async (dir, args) => {
    if (dir !== "/repo" || answer.now === "no repo") return undefined;
    if (answer.now === "timeout") return GIT_TIMED_OUT;
    return args[0] === "status" ? "# branch.head main\n" : undefined;
  };
  return { run, answer };
}

/** A `trunk` checkout whose origin names trunk as its default branch; `slowOrigin` times out reading origin's HEAD. */
const trunk: RunGit = async (_dir, args) => (args[0] === "status" ? "# branch.head trunk\n" : "origin/trunk\n");
const slowOrigin: RunGit = async (_dir, args) => (args[0] === "status" ? "# branch.head trunk\n" : GIT_TIMED_OUT);

describe("collectGitFacts across ticks (#1606)", () => {
  const mainFacts = { branch: "main", detached: false, onDefault: true, ahead: 0, behind: 0, dirty: false };

  test("a timed-out read keeps the directory's last facts for a bounded number of ticks, then drops them", async () => {
    const { run, answer } = scripted();
    const memory: GitFactsMemory = new Map();
    expect((await collectGitFacts(["/repo"], run, memory)).dirs).toEqual({ "/repo": mainFacts });
    answer.now = "timeout";
    for (let tick = 1; tick <= KEEP_TIMED_OUT_TICKS; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- ticks run one after another
      expect((await collectGitFacts(["/repo"], run, memory)).dirs).toEqual({ "/repo": mainFacts });
    }
    expect((await collectGitFacts(["/repo"], run, memory)).dirs).toEqual({});
  });

  test("an answered read resets the bound", async () => {
    const { run, answer } = scripted();
    const memory: GitFactsMemory = new Map();
    await collectGitFacts(["/repo"], run, memory);
    answer.now = "timeout";
    await collectGitFacts(["/repo"], run, memory);
    answer.now = "facts";
    await collectGitFacts(["/repo"], run, memory);
    answer.now = "timeout";
    for (let tick = 1; tick <= KEEP_TIMED_OUT_TICKS; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- ticks run one after another
      expect((await collectGitFacts(["/repo"], run, memory)).dirs).toEqual({ "/repo": mainFacts });
    }
  });

  test("a directory that stops being a repository drops at once, and a later timeout has nothing to keep", async () => {
    const { run, answer } = scripted();
    const memory: GitFactsMemory = new Map();
    await collectGitFacts(["/repo"], run, memory);
    answer.now = "no repo";
    expect((await collectGitFacts(["/repo"], run, memory)).dirs).toEqual({});
    answer.now = "timeout";
    expect((await collectGitFacts(["/repo"], run, memory)).dirs).toEqual({});
  });

  test("a directory no terminal sits in any more is forgotten", async () => {
    const { run, answer } = scripted();
    const memory: GitFactsMemory = new Map();
    await collectGitFacts(["/repo"], run, memory);
    await collectGitFacts([], run, memory);
    answer.now = "timeout";
    expect((await collectGitFacts(["/repo"], run, memory)).dirs).toEqual({});
  });

  test("a timed-out read of origin's HEAD keeps the last facts rather than guessing the default branch", async () => {
    const memory: GitFactsMemory = new Map();
    await collectGitFacts(["/repo"], trunk, memory);
    expect((await collectGitFacts(["/repo"], slowOrigin, memory)).dirs["/repo"]?.onDefault).toBe(true);
  });
});

const doc = {
  v: 1 as const,
  dirs: { "/r": { branch: "x", detached: false, onDefault: false, ahead: 0, behind: 0, dirty: true } },
};

/** A core whose document holds `held` and moves to a new version on each read; it refuses the first `conflicts` sets. */
function core(held: JsonValue, conflicts: number) {
  const sets: { readonly value: JsonValue; readonly version: number }[] = [];
  let reads = 0;
  let refused = 0;
  const call = async (method: string, params: { value?: JsonValue; version?: number }) => {
    if (method === "doc.get") {
      reads += 1;
      return { value: held, version: reads };
    }
    sets.push({ value: params.value ?? null, version: params.version ?? 0 });
    if (refused < conflicts) {
      refused += 1;
      throw new HcRpcError({ code: -32000, message: "version moved", data: { kind: "conflict" } });
    }
    return { version: (params.version ?? 0) + 1 };
  };
  return { connection: { call } as never, sets };
}

describe("writeGitFacts", () => {
  test("writes what changed, at the version it read", async () => {
    const { connection, sets } = core(null, 0);
    expect(await writeGitFacts(connection, doc)).toBe("written");
    expect(sets).toEqual([{ value: doc, version: 1 }]);
  });

  test("leaves the document alone when it already says the same", async () => {
    const { connection, sets } = core(doc, 0);
    expect(await writeGitFacts(connection, doc)).toBe("unchanged");
    expect(sets).toEqual([]);
  });

  test("a conflict is read again and written once more", async () => {
    const { connection, sets } = core(null, 1);
    expect(await writeGitFacts(connection, doc)).toBe("written");
    expect(sets.map((set) => set.version)).toEqual([1, 2]);
  });
});

describe("publishGitFacts", () => {
  test("a link that cannot be spawned is logged once, not thrown, and stop ends the ticks", async () => {
    const logged: string[] = [];
    let spawns = 0;
    const publisher = publishGitFacts(
      { hc: "/nonexistent/hc" },
      (line) => logged.push(line),
      () => {
        spawns += 1;
        throw new Error("ENOENT: no such file or directory, posix_spawn '/nonexistent/hc'");
      },
    );
    await publisher.stop();
    expect(spawns).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("cannot write the git facts on its core");
    expect(publisher.kill()).toEqual([]);
  });
});
