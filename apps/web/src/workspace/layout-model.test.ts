import type { JsonObject, Terminal } from "@doriface/protocol";
import { docSpaces, panesOf, tabsOf } from "@doriface/protocol/layout";
import { describe, expect, test } from "bun:test";
import {
  adoptLoose,
  afterClosing,
  buildTabs,
  HOME_SPACE,
  keepMounts,
  keepTransient,
  layoutIds,
  looseKey,
  newMounts,
  pick,
  TRANSIENT,
  type LayoutTab,
} from "./layout-model.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

const here: MachineLayout = {
  machine: null,
  machineId: null,
  doc: null,
  loaded: true,
  unread: null,
  readOnly: null,
  edit: () => Promise.resolve(true),
};

const live: Terminal = {
  address: "t1",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work",
  labels: {},
  screen: "exact",
  state: "live",
};

test("the first live terminal shown alone is kept when a new tab opens, on this machine or another", () => {
  const [alone] = buildTabs([here], [live]);
  expect(alone?.transient).toBe(true);
  const tab = alone ?? null;
  expect(keepTransient(tab, "t2", true)).toBe("with-new");
  // buildTabs stops showing it once any document holds a tab, so a tab on another machine would hide it.
  expect(keepTransient(tab, "build-box/t1", true)).toBe("apart");
  expect(keepTransient(tab, "t2", false)).toBe("apart");
  expect(keepTransient(tab, "t1", true)).toBeNull();
  const loose: LayoutTab | null = tab === null ? null : { ...tab, key: looseKey("t1", layoutIds([here])) };
  expect(keepTransient(loose, "build-box/t1", true)).toBeNull();
});

test("an added machine's loose tab keeps its key when the machine is renamed, so it stays the tab in view (#459)", () => {
  const box = (name: string): MachineLayout => ({
    ...here,
    machine: name,
    machineId: "id-box",
    readOnly: "the layout is loading",
  });
  const [before] = buildTabs([here, box("build-box")], [], ["build-box/t1"]);
  const [after] = buildTabs([here, box("build-renamed")], [], ["build-renamed/t1"]);
  expect(after?.key).toBe(before?.key ?? "");
  expect(after?.panes.map((pane) => pane.address)).toEqual(["build-renamed/t1"]);
});

test("a live terminal is shown alone only while the core has no layout; a layout whose tabs were all closed shows none (#354)", () => {
  expect(buildTabs([here], [live]).map((tab) => tab.transient)).toEqual([true]);
  expect(buildTabs([{ ...here, doc: { spaces: [] } }], [live])).toEqual([]);
});

test("closing the tab in view shows the last of the others, so the keyboard lands in a terminal that is left", () => {
  const [alone] = buildTabs([here], [live]);
  if (alone === undefined) throw new Error("no tab for the live terminal");
  const tabs = [
    { ...alone, key: "inherited" },
    { ...alone, key: "remaining" },
    { ...alone, key: "closed" },
  ];
  expect(afterClosing(tabs, "closed")).toBe("remaining");
  expect(afterClosing(tabs, "remaining")).toBe("closed");
  expect(afterClosing(tabs, "inherited")).toBe("remaining");
  expect(afterClosing([alone], alone.key)).toBeNull();
});

test("closing a space's last tab shows the space that takes its place, else the last, on the tab it showed last", () => {
  const [alone] = buildTabs([here], [live]);
  if (alone === undefined) throw new Error("no tab for the live terminal");
  const tab = (key: string, spaceKey: string): LayoutTab => ({ ...alone, key, spaceKey });
  const tabs = [tab("a1", "a"), tab("b1", "b"), tab("c1", "c"), tab("c2", "c")];
  expect(afterClosing(tabs, "b1", { c: "c2" })).toBe("c2");
  expect(afterClosing(tabs, "b1")).toBe("c1");
  expect(afterClosing(tabs.slice(0, 2), "b1")).toBe("a1");
});

const alone = (address: string): LayoutTab => ({
  key: TRANSIENT,
  id: TRANSIENT,
  space: "",
  spaceKey: "space:",
  machine: null,
  name: "",
  root: { children: [], id: "", type: "row" },
  panes: [{ id: TRANSIENT, address, mod: null }],
  readOnly: null,
  pinned: false,
  transient: false,
});
const shownAlone = (address: string): LayoutTab => ({ ...alone(address), transient: true });
const docTab = (key: string, pane: string, address: string): LayoutTab => ({
  ...alone(address),
  key,
  id: key,
  panes: [{ id: pane, address, mod: null }],
});

describe("keepMounts: a document tab that takes over a terminal shown alone keeps its view (#381)", () => {
  const none = layoutIds([here]);

  test("the tab written for it is mounted where the lone tab was, its pane too, and stays so", () => {
    const mounts = newMounts();
    keepMounts([shownAlone("box/t2")], mounts, none);
    const [taken] = keepMounts([docTab("core/tb1", "p1", "box/t2")], mounts, none);
    expect(taken?.mount).toBe(TRANSIENT);
    expect(taken?.panes[0]?.mount).toBe(TRANSIENT);
    expect(taken?.key).toBe("core/tb1");
    expect(taken?.panes[0]?.id).toBe("p1");
    const [again] = keepMounts([docTab("core/tb1", "p1", "box/t2"), docTab("core/tb2", "p2", "box/t3")], mounts, none);
    expect(again?.mount).toBe(TRANSIENT);
  });

  test("a tab for a terminal never shown alone mounts under its own key", () => {
    const mounts = newMounts();
    const [tab] = keepMounts([docTab("core/tb1", "p1", "box/t2")], mounts, none);
    expect(tab?.mount).toBeUndefined();
  });

  test("a tab that first showed without the take-over does not take it later, so its view never moves", () => {
    const mounts = newMounts();
    keepMounts([docTab("core/tb1", "p1", "box/t2")], mounts, none);
    keepMounts([shownAlone("box/t2")], mounts, none);
    const [tab] = keepMounts([docTab("core/tb1", "p1", "box/t2")], mounts, none);
    expect(tab?.mount).toBeUndefined();
  });

  test("a loose tab adopted into its machine's layout keeps the selection in the tab that took its view (#495)", () => {
    const ids = layoutIds([here]);
    const key = looseKey("box/t2", ids);
    const mounts = newMounts();
    keepMounts([docTab("core/tb0", "p0", "t1"), { ...shownAlone("box/t2"), key, id: key }], mounts, none);
    const tabs = keepMounts([docTab("core/tb0", "p0", "t1"), docTab("box/tb1", "p1", "box/t2")], mounts, none);
    const view = { active: key, focused: { [key]: TRANSIENT }, zoomed: {}, spaces: {}, seen: {} };
    expect(pick(tabs, view).active?.key).toBe("box/tb1");
    expect(pick(tabs, view).focused?.address).toBe("box/t2");
    expect(pick(tabs, { ...view, active: "gone" }).active?.key).toBe("core/tb0");
  });

  test("a loose tab that outlives the document tab that showed its terminal keeps that tab's keys and its selection", () => {
    const ids = layoutIds([here]);
    const key = looseKey("box/t2", ids);
    const mounts = newMounts();
    keepMounts([docTab("core/tb0", "p0", "t1"), docTab("box/tb1", "p1", "box/t2")], mounts, ids);
    // The document read back without box/tb1 (its write was never saved); the terminal stays here as a loose tab.
    const tabs = keepMounts([docTab("core/tb0", "p0", "t1"), { ...shownAlone("box/t2"), key, id: key }], mounts, ids);
    expect(tabs[1]?.mount).toBe("box/tb1");
    expect(tabs[1]?.panes[0]?.mount).toBe("p1");
    const view = { active: "box/tb1", focused: { "box/tb1": "p1" }, zoomed: {}, spaces: {}, seen: {} };
    expect(pick(tabs, view).active?.key).toBe(key);
    // Written again later (a retry that saved), the document tab takes the same keys back: the view never moves.
    const [, written] = keepMounts([docTab("core/tb0", "p0", "t1"), docTab("box/tb7", "p7", "box/t2")], mounts, ids);
    expect(written?.mount).toBe("box/tb1");
    expect(written?.panes[0]?.mount).toBe("p1");
  });

  test("a loose tab's view is taken over when its machine's rename and the adoption show in one render (#1775)", () => {
    const box = (name: string): MachineLayout => ({ ...here, machine: name, machineId: "id-box" });
    const before = layoutIds([here, box("build-box")]);
    const key = looseKey("build-box/t2", before);
    const mounts = newMounts();
    keepMounts([docTab("core/tb0", "p0", "t1"), { ...shownAlone("build-box/t2"), key, id: key }], mounts, before);
    const after = layoutIds([here, box("build-renamed")]);
    const adopted = docTab("id-box/tb1", "p1", "build-renamed/t2");
    const tabs = keepMounts([docTab("core/tb0", "p0", "t1"), adopted], mounts, after);
    const view = { active: key, focused: { [key]: TRANSIENT }, zoomed: {}, spaces: {}, seen: {} };
    expect(pick(tabs, view).active?.key).toBe("id-box/tb1");
    expect(pick(tabs, view).focused?.address).toBe("build-renamed/t2");
  });

  test("a loose tab first shown before its machine is listed is taken over when the listing and the adoption show in one render (#2107)", () => {
    const key = looseKey("box/t2", none);
    const mounts = newMounts();
    keepMounts([docTab("core/tb0", "p0", "t1"), { ...shownAlone("box/t2"), key, id: key }], mounts, none);
    const listed = layoutIds([here, { ...here, machine: "box", machineId: "id-box" }]);
    const tabs = keepMounts([docTab("core/tb0", "p0", "t1"), docTab("id-box/tb1", "p1", "box/t2")], mounts, listed);
    const view = { active: key, focused: { [key]: TRANSIENT }, zoomed: {}, spaces: {}, seen: {} };
    expect(pick(tabs, view).active?.key).toBe("id-box/tb1");
    expect(pick(tabs, view).focused?.address).toBe("box/t2");
  });

  test("a loose tab listed in one render and saved in a later one leaves no mount for a later tab on its address (#2141)", () => {
    const key = looseKey("box/t2", none);
    const mounts = newMounts();
    keepMounts([docTab("core/tb0", "p0", "t1"), { ...shownAlone("box/t2"), key, id: key }], mounts, none);
    const listed = layoutIds([here, { ...here, machine: "box", machineId: "id-box" }]);
    const relisted = looseKey("box/t2", listed);
    keepMounts(
      [docTab("core/tb0", "p0", "t1"), { ...shownAlone("box/t2"), key: relisted, id: relisted }],
      mounts,
      listed,
    );
    keepMounts([docTab("core/tb0", "p0", "t1"), docTab("id-box/tb1", "p1", "box/t2")], mounts, listed);
    const [, later] = keepMounts(
      [docTab("core/tb0", "p0", "t1"), docTab("id-box/tb2", "p2", "box/t2")],
      mounts,
      listed,
    );
    expect(later?.mount).toBeUndefined();
  });

  test("two document tabs never share the lone tab's mount", () => {
    const mounts = newMounts();
    keepMounts([shownAlone("box/t2")], mounts, none);
    keepMounts([docTab("core/tb1", "p1", "box/t2")], mounts, none);
    keepMounts([shownAlone("box/t9")], mounts, none);
    const tabs = keepMounts([docTab("core/tb1", "p1", "box/t2"), docTab("core/tb9", "p9", "box/t9")], mounts, none);
    expect(tabs.map((tab) => tab.mount ?? tab.key)).toEqual([TRANSIENT, "core/tb9"]);
  });
});

const loose = (address: string, cwd: string, fields: Partial<Terminal> = {}): Terminal =>
  ({
    address,
    argv: ["sh"],
    cols: 80,
    rows: 24,
    created_ms: 0,
    cwd,
    labels: {},
    screen: "exact",
    state: "live",
    ...fields,
  }) as Terminal;
const ids = (): ((prefix: "tb" | "p" | "spc") => string) => {
  let n = 0;
  return (prefix) => `${prefix}${(n += 1)}`;
};
const saved: JsonObject = {
  spaces: [
    {
      id: "spc-w",
      name: "",
      folder: "/w",
      tabs: [
        {
          id: "tb-x",
          name: "",
          root: { children: [{ content: { terminal: "t1" }, id: "p-x", type: "block" }], id: "tb-x", type: "row" },
        },
      ],
    },
    { id: "spc-api", name: "", folder: "/w/api", tabs: [] },
  ],
};
const where = (doc: JsonObject | null) =>
  doc === null ? null : tabsOf(doc).map((tab) => [tab.space, panesOf(tab.root).map((pane) => pane.terminal)]);

describe("adoptLoose (#404)", () => {
  test("a terminal no tab shows goes to the deepest space whose folder holds it, else to one Home space", () => {
    const adopted = adoptLoose(
      saved,
      [loose("t1", "/w"), loose("t2", "/w/api/src"), loose("t3", "/w/web"), loose("t4", "/tmp"), loose("t5", "/srv")],
      ids(),
    );
    expect(where(adopted)).toEqual([
      ["spc-w", ["t1"]],
      ["spc-w", ["t3"]],
      ["spc-api", ["t2"]],
      ["spc7", ["t4"]],
      ["spc7", ["t5"]],
    ]);
    expect(adopted === null ? null : docSpaces(adopted).at(-1)?.name).toBe(HOME_SPACE);
  });

  test("nothing to adopt writes nothing: shown, finished and started-by-another terminals stay as they are", () => {
    expect(
      adoptLoose(saved, [
        loose("t1", "/w"),
        loose("t6", "/w", { state: "finished" }),
        loose("t7", "/w", { parent: "t1" }),
      ]),
    ).toBeNull();
  });

  test("a terminal that End is ending is not adopted back: its closed tab stays closed while its program goes (#2122)", () => {
    expect(adoptLoose(saved, [loose("t6", "/w", { labels: { "herdr.end": "1" } })])).toBeNull();
  });

  test("a terminal labelled with a space goes to the space of that name, made when there is none (#395)", () => {
    const adopted = adoptLoose(
      saved,
      [
        loose("t2", "/w/api", { labels: { space: "api-x" } }),
        loose("t3", "/tmp", { labels: { space: "api-x" } }),
        loose("t4", "/tmp"),
      ],
      ids(),
    );
    expect(adopted === null ? null : docSpaces(adopted).map((space) => [space.name, space.tabs.length])).toEqual([
      ["", 1],
      ["", 0],
      ["api-x", 2],
      [HOME_SPACE, 1],
    ]);
  });

  test("tabs follow the order the terminals started, not hc's text order of their addresses (#1269)", () => {
    const listed = [loose("t10", "/a", { created_ms: 20 }), loose("t9", "/a", { created_ms: 10 })];
    expect(where(adoptLoose(null, listed, ids()))).toEqual([
      ["spc3", ["t9"]],
      ["spc3", ["t10"]],
    ]);
    const sameMs = [loose("t10", "/a"), loose("t9", "/a")];
    expect(where(adoptLoose(null, sameMs, ids()))).toEqual([
      ["spc3", ["t9"]],
      ["spc3", ["t10"]],
    ]);
  });

  test("adopting again adopts nothing more, and an existing Home is reused", () => {
    const once = adoptLoose(null, [loose("t1", "/a")], ids());
    expect(once === null ? null : adoptLoose(once, [loose("t1", "/a")])).toBeNull();
    const twice = once === null ? null : adoptLoose(once, [loose("t1", "/a"), loose("t2", "/b")], ids());
    expect(twice === null ? null : docSpaces(twice).map((space) => [space.name, space.tabs.length])).toEqual([
      [HOME_SPACE, 2],
    ]);
  });
});
