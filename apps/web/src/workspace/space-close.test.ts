import { describe, expect, test } from "bun:test";
import { HcRpcError, type JsonObject, type Terminal } from "@doriface/protocol";
import { docSpaces, type DocEdit } from "@doriface/protocol/layout";
import { layoutSpaces, type ListedSpace } from "./model.ts";
import { phoneSpaces } from "./phone-space-rows.ts";
import type { SessionCalls } from "./session-actions.ts";
import { closeCounts, closeRefusal, closeSpace } from "./space-close.ts";
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

/** hc's End calls (label, kill, rm), recorded; an End of an address in `refuse` fails with that kind. */
function hcEnds(refuse: Readonly<Record<string, string>> = {}) {
  const ended: string[] = [];
  const removed: string[] = [];
  const calls: SessionCalls = {
    label: () => Promise.resolve({}),
    kill: ({ terminal: address }) => {
      const kind = refuse[address];
      if (kind !== undefined) return Promise.reject(new HcRpcError({ code: -32000, message: kind, data: { kind } }));
      ended.push(address);
      return Promise.resolve({ state: "finished" });
    },
    rm: ({ terminal: address }) => {
      removed.push(address);
      return Promise.resolve({});
    },
  };
  return { calls, ended, removed };
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

describe("closing a space", () => {
  test("every program its tabs run ends, and the space with its tabs leaves its own machine's document", async () => {
    const { here, there, layouts, spaces, id } = setup();
    const hc = hcEnds();
    await closeSpace(hc.calls, layouts, spaces, TERMINALS, id("api"));
    // t3's program had already ended, so only the two live ones are ended and removed from hc.
    expect(hc.ended).toEqual(["t1", "t2"]);
    expect(hc.removed).toEqual(["t1", "t2"]);
    expect(here.state.writes).toBe(1);
    expect(there.state.writes).toBe(0);
    expect(docSpaces(here.state.doc).map((each) => each.id)).toEqual(["spc-web", "spc-docs"]);
    expect(
      layoutSpaces([{ ...here.layout, doc: here.state.doc }, there.layout], TERMINALS).map((each) => each.name),
    ).toEqual(["web", "docs", "web"]);
  });

  test("the other spaces are the objects that were read, and only the closed space is written", async () => {
    const { here, layouts, spaces, id } = setup();
    const before = here.state.doc["spaces"];
    await closeSpace(hcEnds().calls, layouts, spaces, TERMINALS, id("api"));
    const after = here.state.doc["spaces"];
    expect(Array.isArray(after) && Array.isArray(before) ? after[0] : null).toBe(
      Array.isArray(before) ? before[1] : null,
    );
  });

  test("a layout that takes no edits is refused before anything ends", async () => {
    const { here, layouts, spaces, id } = setup("the machine is not connected");
    const hc = hcEnds();
    await expect(closeSpace(hc.calls, layouts, spaces, TERMINALS, id("api"))).rejects.toThrow(
      "The layout cannot take changes now: the machine is not connected",
    );
    expect(hc.ended).toEqual([]);
    expect(here.state.writes).toBe(0);
  });

  test("a session that will not end fails the close and leaves the space in the document", async () => {
    const { here, layouts, spaces, id } = setup();
    const hc = hcEnds({ t2: "unreachable" });
    await expect(closeSpace(hc.calls, layouts, spaces, TERMINALS, id("api"))).rejects.toThrow("unreachable");
    expect(hc.ended).toEqual(["t1"]);
    expect(here.state.writes).toBe(0);
  });

  test("a terminal removed meanwhile is no failure: the space still goes", async () => {
    const { here, layouts, spaces, id } = setup();
    await closeSpace(hcEnds({ t1: "not_found" }).calls, layouts, spaces, TERMINALS, id("api"));
    expect(here.state.writes).toBe(1);
  });

  test("every session it ends is dropped once by the close's own write, before any End runs", async () => {
    const { layouts, spaces, id } = setup();
    const hc = hcEnds();
    const did: string[] = [];
    const calls: SessionCalls = {
      ...hc.calls,
      kill: (params) => {
        did.push(`kill ${params.terminal}`);
        return hc.calls.kill(params);
      },
    };
    await closeSpace(calls, layouts, spaces, TERMINALS, id("api"), {
      closing: (addresses) => did.push(`closing ${addresses.join(",")}`),
      kept: (address) => did.push(`kept ${address}`),
    });
    // t3's program had already ended: the two live ones are the close's one drop.
    expect(did).toEqual(["closing t1,t2", "kill t1", "kill t2"]);
  });

  test("an End that fails releases that session, so its later end drops its pane again", async () => {
    const { layouts, spaces, id } = setup();
    const hc = hcEnds({ t2: "unreachable" });
    const kept: string[] = [];
    await expect(
      closeSpace(hc.calls, layouts, spaces, TERMINALS, id("api"), {
        closing: () => undefined,
        kept: (address) => kept.push(address),
      }),
    ).rejects.toThrow("unreachable");
    expect(kept).toEqual(["t2"]);
  });

  test("a space no layout holds is refused with why", () => {
    const { layouts, id } = setup();
    expect(closeRefusal(layouts, "spc-gone")).toBe("This space is no longer in the layout.");
    expect(closeRefusal(layouts, id("api"))).toBeNull();
  });
});

describe("what a space's Close question counts (#2135)", () => {
  test("on a desktop, every tab of the document and every terminal they show, as its strip shows them", () => {
    const { spaces, id } = setup();
    const api = spaces.find((each) => each.id === id("api"));
    expect(closeCounts(api, TERMINALS, false)).toEqual({ tabs: 3, terminals: 3 });
  });

  test("on a phone, the tabs its space row counts and the terminals they show: a finished tab is in neither", () => {
    const { spaces, id } = setup();
    const api = spaces.find((each) => each.id === id("api"));
    // api's three tabs show t1, t2 and the finished t3: its phone row reads 2, and so does its question.
    const row = phoneSpaces(spaces, TERMINALS).find((each) => each.id === id("api"));
    expect(row?.tabs).toBe(2);
    expect(closeCounts(api, TERMINALS, true)).toEqual({ tabs: 2, terminals: 2 });
  });

  test("a space no list holds counts nothing", () => {
    expect(closeCounts(undefined, TERMINALS, true)).toEqual({ tabs: 0, terminals: 0 });
    expect(closeCounts(undefined, TERMINALS, false)).toEqual({ tabs: 0, terminals: 0 });
  });
});
