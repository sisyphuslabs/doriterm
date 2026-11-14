import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JsonObject } from "@doriface/protocol";
import { panesOf, tabsOf } from "@doriface/protocol/layout";
import { tabKey } from "../layout/view.ts";
import { act, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MachineLayout } from "./use-layout-docs.ts";
import { type TabOpening, type TabOpeningDeps, useTabOpening } from "./use-tab-opening.ts";

// bun test has no DOM: React's client renderer reads `window` and a container, as in join-offer-hook.test.tsx.
const view = { HTMLIFrameElement: function NoFrame() {}, document: { activeElement: null } };
const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  namespaceURI: "http://www.w3.org/1999/xhtml",
  addEventListener() {},
  removeEventListener() {},
  ownerDocument: { addEventListener() {}, removeEventListener() {}, defaultView: view },
} as unknown as Element;

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view, document: view.document });
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window", "document"]) Reflect.deleteProperty(globalThis, key);
});

interface Seen {
  readonly shown: { key: string; pane: string | null }[];
  readonly keptHere: string[];
  loose: readonly string[];
  readonly written: (JsonObject | null)[];
}

/** This core's layout: its document, and whether the core takes the edit. */
function layoutOf(doc: JsonObject | null, takes: boolean, seen: Seen, readOnly: string | null = null): MachineLayout {
  return {
    machine: null,
    machineId: null,
    doc,
    loaded: true,
    readOnly,
    edit: (change) => {
      const next = change(doc);
      seen.written.push(next);
      return Promise.resolve(takes && next !== null);
    },
  };
}

/** Renders useTabOpening over `layout` with no tab in view, and hands back its callbacks and what they did. */
async function opening(layout: MachineLayout | undefined, seen: Seen): Promise<TabOpening> {
  let got: TabOpening | undefined;
  const deps: TabOpeningDeps = {
    active: null,
    tabs: [],
    terminals: [],
    layoutOf: () => layout,
    show: (key, pane) => seen.shown.push({ key, pane }),
    goInstead: () => {
      throw new Error("no other device holds the terminal here");
    },
    keepHere: (address) => seen.keptHere.push(address),
    setLoose: (change: SetStateAction<readonly string[]>) => {
      seen.loose = typeof change === "function" ? change(seen.loose) : change;
    },
  };
  function Probe(): null {
    got = useTabOpening(deps);
    return null;
  }
  await act(async () => root.render(<Probe />));
  if (got === undefined) throw new Error("the hook did not render");
  return got;
}

const fresh = (): Seen => ({ shown: [], keptHere: [], loose: [], written: [] });

describe("useTabOpening (#2470 review)", () => {
  test("a terminal opened on a writable machine is written as a new tab holding it, and that tab is shown", async () => {
    const seen = fresh();
    const { openTerminal } = await opening(layoutOf(null, true, seen), seen);
    await act(async () => openTerminal("t7"));
    const doc = seen.written[0];
    const tab = doc === null || doc === undefined ? undefined : tabsOf(doc)[0];
    const panes = tab === undefined ? [] : panesOf(tab.root);
    expect(panes.map((pane) => pane.terminal)).toEqual(["t7"]);
    expect(seen.shown).toEqual([{ key: `${tabKey(null, tab?.id ?? "")}`, pane: panes[0]?.id ?? null }]);
    expect(seen.keptHere).toEqual([]);
    expect(seen.loose).toEqual([]);
  });

  test("a machine that takes no edits keeps the terminal on this screen and writes nothing", async () => {
    const seen = fresh();
    const { openTerminal } = await opening(layoutOf(null, true, seen, "read only"), seen);
    await act(async () => openTerminal("t7"));
    expect(seen.keptHere).toEqual(["t7"]);
    expect(seen.written).toEqual([]);
  });

  test("a write the machine refuses leaves the terminal on this screen as a loose tab", async () => {
    const seen = fresh();
    const { openTerminal } = await opening(layoutOf(null, false, seen), seen);
    await act(async () => openTerminal("t7"));
    expect(seen.loose).toEqual(["t7"]);
  });
});
