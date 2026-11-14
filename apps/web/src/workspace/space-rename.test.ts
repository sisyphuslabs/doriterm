import { describe, expect, test } from "bun:test";
import { HcRpcError, type JsonObject, type Terminal, type TerminalLabelParams } from "@doriface/protocol";
import type { DocEdit } from "@doriface/protocol/layout";
import { layoutSpaces, type ListedSpace } from "./model.ts";
import { renameRefusal, renameSpace, spaceNameProblem } from "./space-rename.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

const terminal = (fields: Partial<Terminal>): Terminal => ({
  address: "t1",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/doriface",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

const tab = (id: string, address: string): JsonObject => ({
  id,
  name: "",
  root: { children: [{ content: { terminal: address }, id: `p-${id}`, type: "block" }], id, type: "row" },
});
const space = (id: string, name: string, folder: string, tabs: readonly JsonObject[]): JsonObject => ({
  folder,
  id,
  name,
  tabs: [...tabs],
});

const HERE: JsonObject = {
  spaces: [
    space("spc-api", "api", "", [tab("a1", "t1"), tab("a2", "t2"), tab("a3", "t3")]),
    space("spc-web", "", "/home/me/web", [tab("w1", "t4")]),
    space("spc-docs", "docs", "", [tab("d1", "t5")]),
    space("spc-empty", "", "/srv/idle", [tab("e1", "t9")]),
  ],
};
const THERE: JsonObject = { spaces: [space("spc-site", "", "/srv/web", [tab("s1", "t1")])] };
const TERMINALS = [
  terminal({ address: "t1" }),
  terminal({ address: "t2", cwd: "/work/elsewhere" }),
  terminal({ address: "t3", state: "finished" }),
  terminal({ address: "t4", cwd: "/home/me/web" }),
  terminal({ address: "box/t1", cwd: "/srv/web" }),
  terminal({ address: "t5" }),
];

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

/** hc's terminal.label, recorded, refusing the addresses in `refuse` with that kind. */
function hcLabels(refuse: Readonly<Record<string, string>> = {}) {
  const labelled: Record<string, Record<string, string>> = {};
  const label = (params: TerminalLabelParams): Promise<unknown> => {
    const kind = refuse[params.terminal];
    if (kind !== undefined) return Promise.reject(new HcRpcError({ code: -32000, message: kind, data: { kind } }));
    labelled[params.terminal] = { ...labelled[params.terminal], ...params.labels };
    return Promise.resolve({});
  };
  return { label, labelled };
}

function setup(readOnly: string | null = null) {
  const here = machineLayout(null, HERE, readOnly);
  const there = machineLayout("box", THERE);
  const layouts = [here.layout, there.layout];
  const spaces = layoutSpaces(layouts, TERMINALS);
  const id = (name: string, machine?: string): string => {
    const found = spaces.find((each: ListedSpace) => each.name === name && each.machine === machine);
    if (found === undefined) throw new Error(`no space ${name}`);
    return found.id;
  };
  return { here, there, layouts, spaces, id };
}

describe("space names", () => {
  test.each([[""], ["   "], ["\t\n"]])("a blank name (%j) is refused", (name) => {
    const { spaces, id } = setup();
    expect(spaceNameProblem(spaces, id("api"), name)).toBe("A space needs a name.");
  });

  test("a name another space of the same machine is shown under is refused; on another machine it is not", () => {
    const { spaces, id } = setup();
    expect(spaceNameProblem(spaces, id("api"), " docs ")).toBe("Another space on this machine is already called docs.");
    expect(spaceNameProblem(spaces, id("api"), "web")).toBe("Another space on this machine is already called web.");
    expect(spaceNameProblem(spaces, id("web", "box"), "api")).toBeNull();
  });

  test("the space's own name and a fresh name are accepted, as is a space with no running terminal", () => {
    const { spaces, id } = setup();
    expect(spaceNameProblem(spaces, id("api"), "api")).toBeNull();
    expect(spaceNameProblem(spaces, id("api"), "backend")).toBeNull();
    expect(spaceNameProblem(spaces, id("idle"), "backend")).toBeNull();
  });

  test("a layout that takes no edits refuses with its reason", () => {
    const { layouts, id } = setup("the machine is not connected");
    expect(renameRefusal(layouts, id("api"))).toBe("The layout cannot take changes now: the machine is not connected");
    expect(renameRefusal(layouts, id("web", "box"))).toBeNull();
  });
});

describe("renaming a space", () => {
  test("the space's name is set in its own machine's layout document, keeping its id, and every client lists it", async () => {
    const { here, there, layouts, spaces, id } = setup();
    const api = id("api");
    await renameSpace(hcLabels(), layouts, spaces, TERMINALS, api, "  backend ");
    expect(here.state.writes).toBe(1);
    expect(there.state.writes).toBe(0);
    const listed = layoutSpaces([{ ...here.layout, doc: here.state.doc }, there.layout], TERMINALS);
    expect(listed.map((each) => [each.id, each.name])).toEqual([
      [api, "backend"],
      [id("web"), "web"],
      [id("docs"), "docs"],
      [id("idle"), "idle"],
      [id("web", "box"), "web"],
    ]);
  });

  test("a space named after its folder is renamed on its own machine only", async () => {
    const { here, there, layouts, spaces, id } = setup();
    await renameSpace(hcLabels(), layouts, spaces, TERMINALS, id("web", "box"), "site");
    expect(here.state.writes).toBe(0);
    expect(layoutSpaces([{ ...there.layout, doc: there.state.doc }], TERMINALS)[0]?.name).toBe("site");
  });

  test("its running terminals get the space label in hc, so one that leaves every tab is adopted back", async () => {
    const { layouts, spaces, id } = setup();
    const hc = hcLabels();
    await renameSpace(hc, layouts, spaces, TERMINALS, id("api"), "backend");
    expect(hc.labelled).toEqual({ t1: { space: "backend" }, t2: { space: "backend" } });
  });

  test("a read-only layout writes nothing and says why", async () => {
    const { here, layouts, spaces, id } = setup("the layout is loading");
    const hc = hcLabels();
    await expect(renameSpace(hc, layouts, spaces, TERMINALS, id("api"), "backend")).rejects.toThrow(
      "The layout cannot take changes now: the layout is loading",
    );
    expect(here.state.writes).toBe(0);
    expect(hc.labelled).toEqual({});
  });

  test("a terminal removed meanwhile is no failure; any other refused label fails the rename after the rest", async () => {
    const { layouts, spaces, id } = setup();
    await expect(
      renameSpace(hcLabels({ t2: "not_found" }), layouts, spaces, TERMINALS, id("api"), "backend"),
    ).resolves.toBeUndefined();
    const hc = hcLabels({ t2: "unreachable" });
    await expect(renameSpace(hc, layouts, spaces, TERMINALS, id("api"), "backend")).rejects.toThrow("unreachable");
    expect(hc.labelled).toEqual({ t1: { space: "backend" } });
  });
});
