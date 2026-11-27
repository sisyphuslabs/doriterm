import type { AgentStatus } from "@doriface/ui";
import { describe, expect, test } from "bun:test";
import {
  agentTree,
  ancestorsOf,
  foldRows,
  hiddenUnder,
  MAX_TREE_DEPTH,
  treeShape,
  type TreeRow,
} from "./agent-tree.ts";
import type { Session } from "./attention.ts";

const terminal = (
  address: string,
  parent: string | null,
  state: string | undefined = undefined,
  extra: Partial<Session> = {},
): Session => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/api",
  labels: { space: "api" },
  screen: "exact",
  state: "live",
  parent,
  ...(state === undefined ? {} : { reported: true, status: { state } }),
  ...extra,
});

/** The tree as `address@depth`, and the invariant every fixture must keep: each live terminal comes out exactly once. */
function drawn(terminals: readonly Session[], statusOf?: (terminal: Session) => AgentStatus): string[] {
  const rows = agentTree(terminals, statusOf);
  const live = terminals.filter((one) => one.state === "live").map((one) => one.address);
  expect(rows.map((row) => row.address).toSorted()).toEqual(live.toSorted());
  return rows.map((row) => `${row.address}@${row.depth}`);
}

const byAddress = (rows: readonly TreeRow[]): Map<string, TreeRow> => new Map(rows.map((row) => [row.address, row]));

describe("agentTree: nesting", () => {
  test("a child is listed right after the agent that started it, depth first, a level deeper", () => {
    expect(drawn([terminal("t1", null), terminal("t2", "t1"), terminal("t3", "t2"), terminal("t4", null)])).toEqual([
      "t1@0",
      "t2@1",
      "t3@2",
      "t4@0",
    ]);
  });

  test("children come in start order, then by address with numbers compared as numbers", () => {
    const fleet = [
      terminal("t1", null),
      terminal("t10", "t1", undefined, { created_ms: 5 }),
      terminal("t9", "t1", undefined, { created_ms: 5 }),
      terminal("t2", "t1", undefined, { created_ms: 9 }),
    ];
    expect(drawn(fleet)).toEqual(["t1@0", "t9@1", "t10@1", "t2@1"]);
  });

  test("a parent is an address as the feed names it: on an added machine qualified, on this one bare", () => {
    const fleet = [
      terminal("box/t3", null),
      terminal("box/t9", "box/t3"),
      terminal("t1", null),
      terminal("box/t4", "box/t9"),
      terminal("t2", "box/t3"),
    ];
    expect(drawn(fleet)).toEqual(["box/t3@0", "box/t9@1", "box/t4@2", "t2@1", "t1@0"]);
  });

  test("a child on an added machine nests under its parent on this machine (#2779)", () => {
    const fleet = [terminal("t3", null), terminal("box/t3", null), terminal("box/t9", "t3")];
    expect(drawn(fleet)).toEqual(["t3@0", "box/t9@1", "box/t3@0"]);
  });

  test("a child whose parent is not listed, ended or unknown, is a top-level row", () => {
    const fleet = [
      terminal("t1", null, undefined, { state: "finished" }),
      terminal("t2", "t1"),
      terminal("t3", "t99"),
      terminal("t4", "gone/t1"),
    ];
    expect(drawn(fleet)).toEqual(["t2@0", "t3@0", "t4@0"]);
  });

  test("--no-parent and a missing parent are top-level", () => {
    const { parent: _, ...bare } = terminal("t2", null);
    expect(drawn([terminal("t1", null), bare])).toEqual(["t1@0", "t2@0"]);
  });

  test("a self-parent and a cycle are top-level, and what hangs off a cycle stays under its parent", () => {
    expect(drawn([terminal("t1", "t1")])).toEqual(["t1@0"]);
    const fleet = [terminal("t1", "t2"), terminal("t2", "t1"), terminal("t3", "t1")];
    expect(drawn(fleet)).toEqual(["t1@0", "t3@1", "t2@0"]);
  });

  test("a chain deeper than the cap goes on as a top-level row, so no row is lost", () => {
    const chain = Array.from({ length: MAX_TREE_DEPTH + 3 }, (_, index) =>
      terminal(`t${index + 1}`, index === 0 ? null : `t${index}`),
    );
    const rows = agentTree(chain);
    expect(rows).toHaveLength(chain.length);
    expect(Math.max(...rows.map((row) => row.depth))).toBe(MAX_TREE_DEPTH);
    expect(rows.filter((row) => row.depth === 0).map((row) => row.address)).toEqual(["t1", `t${MAX_TREE_DEPTH + 2}`]);
  });

  test("an offline machine's terminals keep their parent and their place", () => {
    const fleet = [terminal("box/t1", null, "working", { offline: true }), terminal("box/t2", "box/t1", "blocked")];
    expect(drawn(fleet)).toEqual(["box/t1@0", "box/t2@1"]);
  });
});

describe("agentTree: shape", () => {
  test("descendants count the whole live subtree", () => {
    const rows = byAddress(
      agentTree([terminal("t1", null), terminal("t2", "t1"), terminal("t3", "t2"), terminal("t4", "t1")]),
    );
    expect([...rows.values()].map((row) => [row.address, row.descendants])).toEqual([
      ["t1", 3],
      ["t2", 1],
      ["t3", 0],
      ["t4", 0],
    ]);
  });

  test("guides: a continuing ancestor, this row's joint, and a spent ancestor", () => {
    const rows = agentTree([
      terminal("t1", null),
      terminal("t2", "t1"),
      terminal("t3", "t2"),
      terminal("t4", "t1"),
      terminal("t5", "t4"),
    ]);
    expect(rows.map((row) => row.guides.join(","))).toEqual(["", "├", "│,└", "└", ",└"]);
  });
});

const urgency = (terminals: readonly Session[], address: string, statusOf?: (t: Session) => AgentStatus) =>
  byAddress(agentTree(terminals, statusOf)).get(address)?.urgency;

const held = (one: Session): AgentStatus => (one.address === "t2" ? "working" : "idle");

const apartT2T4 = (one: Session): boolean => one.address === "t2" || one.address === "t4";

describe("agentTree: urgency", () => {
  test("a leaf's urgency is its own status, done included", () => {
    expect(urgency([terminal("t1", null, "done")], "t1")).toBe("done");
  });

  test("a parent takes the most urgent of itself and its live descendants, by the sections' order", () => {
    const fleet = [terminal("t1", null, "idle"), terminal("t2", "t1", "working"), terminal("t3", "t2", "blocked")];
    expect(urgency(fleet, "t1")).toBe("blocked");
    expect(urgency(fleet, "t2")).toBe("blocked");
    expect(urgency(fleet, "t3")).toBe("blocked");
  });

  test("a child's done reads as idle for its parent: a working parent stays working, an idle one idle", () => {
    expect(urgency([terminal("t1", null, "working"), terminal("t2", "t1", "done")], "t1")).toBe("working");
    expect(urgency([terminal("t1", null, "idle"), terminal("t2", "t1", "done")], "t1")).toBe("idle");
  });

  test("an offline descendant never bubbles", () => {
    const fleet = [terminal("t1", null, "idle"), terminal("t2", "t1", "blocked", { offline: true })];
    expect(urgency(fleet, "t1")).toBe("idle");
  });

  test("an offline parent with a live blocked child carries the child's urgency", () => {
    const fleet = [terminal("box/t1", null, "working", { offline: true }), terminal("t2", "box/t1", "blocked")];
    expect(urgency(fleet, "box/t1")).toBe("blocked");
  });

  test("the status read is the caller's: a held place counts, not the live state", () => {
    const fleet = [terminal("t1", null, "idle"), terminal("t2", "t1", "idle")];
    expect(urgency(fleet, "t1", held)).toBe("working");
  });

  test("a row listed apart from its parent keeps its urgency and lends none upward; one inside a row already apart still does", () => {
    const fleet = [
      terminal("t1", null, "idle"),
      terminal("t2", "t1", "blocked"),
      terminal("t3", "t2", "working"),
      terminal("t4", "t3", "blocked"),
    ];
    const rows = agentTree(fleet, undefined, apartT2T4);
    expect(rows.map((row) => [row.address, row.urgency])).toEqual([
      ["t1", "idle"],
      ["t2", "blocked"],
      ["t3", "blocked"],
      ["t4", "blocked"],
    ]);
  });
});

describe("treeShape", () => {
  test("guides and descendants come from the drawn depths alone", () => {
    expect(treeShape([0, 1, 2, 1, 0])).toEqual({
      guides: [[], ["├"], ["│", "└"], ["└"], []],
      descendants: [3, 1, 0, 0, 0],
    });
  });
});

describe("ancestorsOf", () => {
  test("the rows above a row, nearest first, read from the depths", () => {
    const rows = [
      { id: "a", depth: 0 },
      { id: "b", depth: 1 },
      { id: "c", depth: 2 },
      { id: "d", depth: 1 },
      { id: "e", depth: 2 },
    ];
    expect(ancestorsOf(rows, 4)).toEqual(["d", "a"]);
    expect(ancestorsOf(rows, 0)).toEqual([]);
  });
});

describe("hiddenUnder", () => {
  const rows = [
    { depth: 0, status: "working" },
    { depth: 1, status: "done" },
    { depth: 2, status: "blocked" },
    { depth: 1, status: "unknown" },
    { depth: 0, status: "blocked" },
  ] as const;

  test("counts the whole subtree and the ones that need the person, and stops at the next row of its own level", () => {
    expect(hiddenUnder(rows, 0)).toEqual({ count: 3, blocked: 1, urgency: "blocked" });
    expect(hiddenUnder(rows, 4)).toEqual({ count: 0, blocked: 0, urgency: "idle" });
  });

  test("a done sub-agent reads as idle and an offline one not at all", () => {
    expect(hiddenUnder([rows[0], rows[1], rows[3]], 0)).toEqual({ count: 2, blocked: 0, urgency: "idle" });
  });
});

describe("foldRows", () => {
  const rows = [
    { id: "a", depth: 0 },
    { id: "b", depth: 1 },
    { id: "c", depth: 2 },
    { id: "d", depth: 0 },
  ];

  test("a folded row hides its subtree and keeps itself", () => {
    expect(foldRows(rows, new Set(["a"]), null).map((row) => row.id)).toEqual(["a", "d"]);
    expect(foldRows(rows, new Set(["b"]), null).map((row) => row.id)).toEqual(["a", "b", "d"]);
  });

  test("the selected row's ancestors are drawn open, so it is never hidden", () => {
    expect(foldRows(rows, new Set(["a", "b"]), "c").map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    expect(foldRows(rows, new Set(["a", "b"]), "b").map((row) => row.id)).toEqual(["a", "b", "d"]);
  });

  test("nothing folded gives back the same list", () => {
    expect(foldRows(rows, new Set(), null)).toBe(rows);
  });
});
