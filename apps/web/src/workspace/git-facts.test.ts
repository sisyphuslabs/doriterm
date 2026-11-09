import type { GitFacts, GitFactsDoc, JsonObject, Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { FAILED_ROUNDS_KEPT, type FactsRead, type FactsRounds, nextDocs, shownGit } from "./git-facts.ts";
import { layoutSpaces } from "./model.ts";

const clean: GitFacts = { branch: "main", detached: false, onDefault: true, ahead: 0, behind: 0, dirty: false };

describe("shownGit: only what is unusual", () => {
  test("a clean default branch in sync says nothing, and neither does a directory with no facts", () => {
    expect(shownGit(clean)).toBeUndefined();
    expect(shownGit(undefined)).toBeUndefined();
  });

  test("another branch, uncommitted changes, ahead, behind or a detached HEAD each say it", () => {
    expect(shownGit({ ...clean, branch: "feat/x", onDefault: false })).toEqual({
      branch: "feat/x",
      detached: false,
      ahead: 0,
      behind: 0,
      dirty: false,
    });
    expect(shownGit({ ...clean, dirty: true })?.dirty).toBe(true);
    expect(shownGit({ ...clean, ahead: 2 })?.ahead).toBe(2);
    expect(shownGit({ ...clean, behind: 3 })?.behind).toBe(3);
    const { branch: _, ...detached } = { ...clean, detached: true, onDefault: false };
    expect(shownGit(detached)).toEqual({ detached: true, ahead: 0, behind: 0, dirty: false });
  });
});

const doc = (branch: string): GitFactsDoc => ({ v: 1, dirs: { "/work": { ...clean, branch } } });

describe("nextDocs: a round of reads", () => {
  const before = new Map<string, GitFactsDoc>([
    ["", doc("main")],
    ["laptop", doc("feat/a")],
  ]);

  test("a read that could not be made keeps the machine's last document, so its facts do not blink out (#913)", () => {
    const next = nextDocs(before, new Map(), [
      ["", doc("main")],
      ["laptop", "failed"],
    ]);
    expect(next.docs.get("laptop")).toEqual(doc("feat/a"));
  });

  test("a machine that answers with no document, or is no longer asked, has none", () => {
    expect(nextDocs(before, new Map(), [["", undefined]]).docs).toEqual(new Map());
    expect([...nextDocs(before, new Map(), [["", doc("dev")]]).docs.keys()]).toEqual([""]);
  });

  test("a failure that persists while the machine reads connected drops its document after a bounded run (#1165)", () => {
    // This page reads every 5 s and holds a redialing line as connected for 75 s (#904): a longer run is no blip.
    let rounds: FactsRounds = { docs: before, misses: new Map() };
    const failed = (): FactsRead[] => [
      ["", doc("main")],
      ["laptop", "failed"],
    ];
    for (let round = 0; round < FAILED_ROUNDS_KEPT; round += 1) rounds = nextDocs(rounds.docs, rounds.misses, failed());
    expect(rounds.docs.get("laptop")).toEqual(doc("feat/a"));
    rounds = nextDocs(rounds.docs, rounds.misses, failed());
    expect(rounds.docs.has("laptop")).toBe(false);
  });

  test("a machine that answers again starts its run of failed reads over", () => {
    let rounds: FactsRounds = { docs: before, misses: new Map() };
    for (let round = 0; round < FAILED_ROUNDS_KEPT; round += 1)
      rounds = nextDocs(rounds.docs, rounds.misses, [["laptop", "failed"]]);
    rounds = nextDocs(rounds.docs, rounds.misses, [["laptop", doc("feat/b")]]);
    for (let round = 0; round < FAILED_ROUNDS_KEPT; round += 1)
      rounds = nextDocs(rounds.docs, rounds.misses, [["laptop", "failed"]]);
    expect(rounds.docs.get("laptop")).toEqual(doc("feat/b"));
    rounds = nextDocs(rounds.docs, rounds.misses, [["laptop", "failed"]]);
    expect(rounds.docs.has("laptop")).toBe(false);
  });
});

const terminal = (address: string, space: string, cwd: string, foreground?: string): Terminal =>
  ({
    address,
    cwd,
    state: "live",
    labels: { space },
    ...(foreground === undefined ? {} : { foreground: { cwd: foreground, argv: [], name: "sh", pid: 1 } }),
  }) as unknown as Terminal;

/** A layout document of one tab per space, each tab one terminal pane (a local address). */
const docOf = (spaces: readonly { id: string; folder: string; terminal: string }[]): JsonObject => ({
  spaces: spaces.map((space) => ({
    id: space.id,
    name: "",
    folder: space.folder,
    tabs: [
      {
        id: `${space.id}-t`,
        name: "",
        root: {
          id: `${space.id}-t`,
          type: "row",
          children: [{ id: `${space.id}-p`, type: "block", content: { terminal: space.terminal } }],
        },
      },
    ],
  })),
});

describe("layout spaces with git facts (#404)", () => {
  test("a space's facts are its folder's, else its first live terminal's directory, on its own machine", () => {
    const asked: [string | undefined, string][] = [];
    const facts = { ...clean, branch: "feat/x", onDefault: false };
    const spaces = layoutSpaces(
      [
        { machine: null, machineId: null, doc: docOf([{ id: "api", folder: "", terminal: "t1" }]) },
        { machine: "box", machineId: "id-box", doc: docOf([{ id: "docs", folder: "/srv/docs", terminal: "t3" }]) },
      ],
      [terminal("t1", "api", "/w/api", "/w/api/src"), terminal("box/t3", "docs", "/srv/docs")],
      (machine, dir) => {
        asked.push([machine, dir]);
        return dir === "/w/api/src" ? facts : undefined;
      },
    );
    expect(asked).toEqual([
      [undefined, "/w/api/src"],
      ["box", "/srv/docs"],
    ]);
    expect(spaces.find((space) => space.machine === undefined)?.git?.branch).toBe("feat/x");
    expect(spaces.find((space) => space.machine === "box")?.git).toBeUndefined();
  });
});
