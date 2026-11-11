import type { JsonObject, Terminal } from "@doriface/protocol";
import { END_LABEL } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { ADOPT_GRACE_MS, type Look, looseTerminals, shownIn, stepAdoption } from "./adoption.ts";

const terminal = (address: string, fields: Partial<Terminal> = {}): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/w",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

/** A layout document of one space whose tabs are rows of terminal panes (local addresses). */
const docOf = (tabs: readonly (readonly string[])[]): JsonObject => ({
  spaces: [
    {
      id: "spc",
      name: "",
      folder: "/w",
      tabs: tabs.map((terminals, index) => ({
        id: `tb${index}`,
        name: "",
        root: {
          id: `tb${index}`,
          type: "row",
          children: terminals.map((local, at) => ({
            id: `p${index}-${at}`,
            type: "block",
            content: { terminal: local },
          })),
        },
      })),
    },
  ],
});

describe("looseTerminals (#2122)", () => {
  test("a live terminal no pane shows is loose; a shown, a finished and a sub-agent's one are not", () => {
    const loose = looseTerminals(docOf([["t1"], ["t2", "t3"]]), [
      terminal("t1"),
      terminal("t3"),
      terminal("t4"),
      terminal("t5", { state: "finished" }),
      terminal("t6", { parent: "t1" }),
    ]);
    expect(loose.map((each) => each.address)).toEqual(["t4"]);
  });

  test("an added machine's terminal is matched by the address its own document names it by", () => {
    const loose = looseTerminals(docOf([["t1"]]), [terminal("box/t1"), terminal("box/t2")]);
    expect(loose.map((each) => each.address)).toEqual(["box/t2"]);
  });

  test("a terminal that End is ending is not loose: its closed tab does not come back while its program goes", () => {
    const ending = terminal("t2", { labels: { [END_LABEL]: "1" } });
    expect(looseTerminals(docOf([["t1"]]), [terminal("t1"), ending])).toEqual([]);
    // End's mark taken back (the kill was refused): it keeps running, in no tab, and is adopted again.
    const kept = terminal("t2", { labels: { [END_LABEL]: "" } });
    expect(looseTerminals(docOf([["t1"]]), [terminal("t1"), kept]).map((each) => each.address)).toEqual(["t2"]);
  });

  test("they come in the order they started, not the feed's text order of addresses (#1269)", () => {
    const listed = [terminal("t10", { created_ms: 20 }), terminal("t9", { created_ms: 10 }), terminal("t11")];
    expect(looseTerminals(null, listed).map((each) => each.address)).toEqual(["t11", "t9", "t10"]);
  });
});

describe("shownIn (#2122)", () => {
  test("names the tab and the pane that show a terminal, also inside a split; null when no tab shows it", () => {
    const doc = docOf([["t1"], ["t2", "t3"]]);
    expect(shownIn(doc, "t3")).toEqual({ tab: "tb1", pane: "p1-1" });
    expect(shownIn(doc, "t9")).toBeNull();
    expect(shownIn(null, "t1")).toBeNull();
  });
});

describe("stepAdoption (#2122)", () => {
  const T0 = 1_000_000;

  test("a machine's first look adopts every loose terminal at once, as a page load did", () => {
    const step = stepAdoption(undefined, ["t1", "t2"], T0);
    expect(step.adopt).toEqual(["t1", "t2"]);
    expect(step.wake).toBeUndefined();
  });

  test("a terminal that turns up later waits the grace from when it was first seen in no tab, then is adopted", () => {
    const first = stepAdoption(undefined, [], T0);
    const seen = stepAdoption(first.look, ["t3"], T0 + 100);
    expect(seen.adopt).toEqual([]);
    expect(seen.wake).toBe(T0 + 100 + ADOPT_GRACE_MS);
    // A look before the grace is over, as any feed event brings one: still waiting, from the same moment.
    const early = stepAdoption(seen.look, ["t3"], T0 + 100 + ADOPT_GRACE_MS - 1);
    expect(early.adopt).toEqual([]);
    expect(early.wake).toBe(T0 + 100 + ADOPT_GRACE_MS);
    const due = stepAdoption(early.look, ["t3"], T0 + 100 + ADOPT_GRACE_MS);
    expect(due.adopt).toEqual(["t3"]);
    expect(due.wake).toBeUndefined();
  });

  test("a terminal whoever started it gave a tab within the grace is never adopted", () => {
    const first = stepAdoption(undefined, [], T0);
    const seen = stepAdoption(first.look, ["t3"], T0);
    const placed = stepAdoption(seen.look, [], T0 + 300);
    expect(placed.adopt).toEqual([]);
    expect(placed.wake).toBeUndefined();
    expect([...placed.look.since]).toEqual([]);
  });

  test("a terminal an adoption was written for is not written again while it is still in no tab", () => {
    const written = stepAdoption(undefined, ["t1"], T0);
    expect(written.adopt).toEqual(["t1"]);
    const again = stepAdoption(written.look, ["t1"], T0 + 10 * ADOPT_GRACE_MS);
    expect(again.adopt).toEqual([]);
    expect(again.wake).toBeUndefined();
  });

  test("a new connection forgets what was written, so a refused adoption is tried again; one that left its tab waits the grace anew", () => {
    const written = stepAdoption(undefined, ["t1"], T0);
    const forgotten: Look = { since: written.look.since, tried: new Set() };
    expect(stepAdoption(forgotten, ["t1"], T0 + 1).adopt).toEqual(["t1"]);
    const shown = stepAdoption(written.look, [], T0 + 1);
    const back = stepAdoption(shown.look, ["t1"], T0 + 2);
    expect(back.adopt).toEqual([]);
    expect(back.wake).toBe(T0 + 2 + ADOPT_GRACE_MS);
  });

  test("the next look is due when the earliest waiting terminal's grace ends", () => {
    const first = stepAdoption(undefined, [], T0);
    const one = stepAdoption(first.look, ["t1"], T0 + 1_000);
    const two = stepAdoption(one.look, ["t1", "t2"], T0 + 3_000);
    expect(two.wake).toBe(T0 + 1_000 + ADOPT_GRACE_MS);
  });
});
