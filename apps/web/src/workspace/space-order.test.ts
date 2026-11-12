import { describe, expect, test } from "bun:test";
import type { JsonObject, Terminal } from "@doriface/protocol";
import type { DocEdit } from "@doriface/protocol/layout";
import { layoutSpaces } from "./model.ts";
import { moveSpace } from "./space-order.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

const terminal = (address: string): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work",
  labels: {},
  screen: "exact",
  state: "live",
});

const tab = (id: string, address: string): JsonObject => ({
  id,
  name: "",
  root: { children: [{ content: { terminal: address }, id: `p-${id}`, type: "block" }], id, type: "row" },
});
const space = (id: string, name: string, tabs: readonly JsonObject[]): JsonObject => ({
  folder: `/work/${name}`,
  id,
  name,
  tabs: [...tabs],
});

const HERE: JsonObject = {
  spaces: [
    space("spc-api", "api", [tab("a1", "t1")]),
    space("spc-web", "web", [tab("w1", "t2")]),
    space("spc-docs", "docs", [tab("d1", "t3")]),
  ],
};
const THERE: JsonObject = {
  spaces: [space("spc-site", "site", [tab("s1", "box/t1")]), space("spc-blog", "blog", [tab("s2", "box/t2")])],
};
const TERMINALS = [terminal("t1"), terminal("t2"), terminal("t3"), terminal("box/t1"), terminal("box/t2")];

/** A machine's layout that applies edits as LayoutDoc does: an edit returning null writes nothing. */
function machineLayout(machine: string | null, doc: JsonObject, readOnly: string | null = null) {
  const state = { doc, writes: 0 };
  const layout: MachineLayout = {
    machine,
    machineId: machine === null ? null : `id-${machine}`,
    doc,
    loaded: true,
    unread: null,
    readOnly,
    edit: (change: DocEdit) => {
      const next = change(state.doc);
      if (next === null) return Promise.resolve(false);
      state.doc = next;
      state.writes += 1;
      return Promise.resolve(true);
    },
  };
  return { layout, state };
}

function setup(readOnly: string | null = null) {
  const here = machineLayout(null, HERE, readOnly);
  const there = machineLayout("box", THERE);
  const layouts = [here.layout, there.layout];
  const spaces = layoutSpaces(layouts, TERMINALS);
  const id = (name: string): string => {
    const found = spaces.find((each) => each.name === name);
    if (found === undefined) throw new Error(`no space ${name}`);
    return found.id;
  };
  return { here, there, layouts, spaces, id };
}

describe("moving a space", () => {
  test("it takes its place in its own machine's document, and every client lists that order", async () => {
    const { here, there, layouts, id } = setup();
    await moveSpace(layouts, id("docs"), 0);
    expect(here.state.writes).toBe(1);
    expect(there.state.writes).toBe(0);
    const listed = layoutSpaces([{ ...here.layout, doc: here.state.doc }, there.layout], TERMINALS);
    expect(listed.map((each) => each.name)).toEqual(["docs", "api", "web", "site", "blog"]);
  });

  test("a space of another machine moves in that machine's document, this one untouched", async () => {
    const { here, there, layouts, id } = setup();
    await moveSpace(layouts, id("blog"), 0);
    expect(here.state.writes).toBe(0);
    expect(there.state.writes).toBe(1);
    expect(layoutSpaces([{ ...there.layout, doc: there.state.doc }], TERMINALS).map((each) => each.name)).toEqual([
      "blog",
      "site",
    ]);
  });

  test("a move to the place it already has writes nothing, and a space that is gone is refused", async () => {
    const { here, layouts, id } = setup();
    await moveSpace(layouts, id("web"), 1);
    expect(here.state.writes).toBe(0);
    await expect(moveSpace(layouts, "space:gone", 0)).rejects.toThrow("This space is no longer in the layout.");
  });

  test("a layout that takes no edits writes nothing and says why", async () => {
    const { here, layouts, id } = setup("the machine is not connected");
    await expect(moveSpace(layouts, id("api"), 2)).rejects.toThrow(
      "The layout cannot take changes now: the machine is not connected",
    );
    expect(here.state.writes).toBe(0);
  });
});
