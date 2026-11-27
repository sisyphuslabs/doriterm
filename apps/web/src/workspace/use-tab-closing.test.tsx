import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Terminal } from "@doriface/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildTabs, type LayoutTab, TRANSIENT } from "./layout-model.ts";
import { newTabWrite, terminalRow } from "./pane-writes.ts";
import type { SessionAsk } from "./session-context.ts";
import { heldClose, type TabClosing, useTabClosing } from "./use-tab-closing.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

// bun test has no DOM: React's client renderer reads `window` and a container, as in use-tab-opening.test.tsx.
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

const here: MachineLayout = {
  machine: null,
  machineId: null,
  doc: null,
  loaded: true,
  readOnly: null,
  edit: () => Promise.resolve(true),
};

const terminal: Terminal = {
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
const ended: Terminal = { ...terminal, state: "finished" };

const placedDoc = newTabWrite(
  null,
  "t1",
  { id: "tb1", name: "", root: terminalRow("tb1", "p1", "t1") },
  { id: "spc1", folder: "" },
  undefined,
  null,
).doc;

/** The terminal shown alone, before its run's answer places it, and the same terminal in its placed tab. */
const alone = buildTabs([here], [terminal]);
const placed = buildTabs([{ ...here, doc: placedDoc }], [terminal]);
const placedKey = placed[0]?.key ?? "";

describe("heldClose", () => {
  test("waits while the run is out and the terminal is shown alone, then goes ahead on its placed tab (#2913)", () => {
    expect(alone.map((tab) => tab.key)).toEqual([TRANSIENT]);
    expect(heldClose(alone, [terminal], "t1", true)).toBe("wait");
    expect(heldClose([], [terminal], "t1", true)).toBe("wait");
    expect(placed.map((tab) => tab.transient)).toEqual([false]);
    expect(heldClose(placed, [terminal], "t1", true)).toBe("close");
  });

  test("is bounded by the run: once it answered or failed the close goes ahead, and a terminal that ended drops it", () => {
    expect(heldClose(alone, [terminal], "t1", false)).toBe("close");
    expect(heldClose(alone, [ended], "t1", true)).toBe("drop");
    expect(heldClose(alone, [], "t1", true)).toBe("drop");
  });
});

interface Seen {
  readonly asks: (SessionAsk | null)[];
  readonly closedTabs: string[];
  got: TabClosing | undefined;
}

interface ProbeProps {
  readonly seen: Seen;
  readonly tabs: readonly LayoutTab[];
  readonly terminals: readonly Terminal[];
  readonly opening: boolean;
}

/** One component across renders, so the hook keeps its state from one render to the next. */
function Probe({ seen, tabs, terminals, opening }: ProbeProps): null {
  seen.got = useTabClosing(
    { tabs, closeTab: (key: string) => seen.closedTabs.push(key) },
    terminals,
    (ask) => seen.asks.push(typeof ask === "function" ? ask(null) : ask),
    () => opening,
  );
  return null;
}

/** Renders useTabClosing over these tabs and terminals, with `opening` saying whether the run is still out. */
async function render(
  seen: Seen,
  tabs: readonly LayoutTab[],
  terminals: readonly Terminal[],
  opening: boolean,
): Promise<TabClosing> {
  await act(async () => root.render(<Probe seen={seen} tabs={tabs} terminals={terminals} opening={opening} />));
  if (seen.got === undefined) throw new Error("the hook did not render");
  return seen.got;
}

const fresh = (): Seen => ({ asks: [], closedTabs: [], got: undefined });

describe("useTabClosing (#2913 review)", () => {
  test("a close of the terminal shown alone is held, shown as taken, then asks Close space? once its tab is placed", async () => {
    const seen = fresh();
    const first = await render(seen, alone, [terminal], true);
    await act(async () => first.closeTab(TRANSIENT));
    const holding = await render(seen, alone, [terminal], true);
    expect([holding.holding, holding.closingTab, seen.asks]).toEqual(["t1", null, []]);
    const answered = await render(seen, placed, [terminal], false);
    expect([answered.holding, answered.closingTab, seen.asks, seen.closedTabs]).toEqual([null, placedKey, [], []]);
  });

  test("with no run out for it, the close of the terminal shown alone goes ahead at once, as before", async () => {
    const seen = fresh();
    const first = await render(seen, alone, [terminal], false);
    await act(async () => first.closeTab(TRANSIENT));
    expect([seen.got?.holding, seen.asks]).toEqual([null, [{ kind: "close", address: "t1" }]]);
  });

  test("a held close whose terminal ends meanwhile is dropped: nothing asks and nothing closes", async () => {
    const seen = fresh();
    const first = await render(seen, alone, [terminal], true);
    await act(async () => first.closeTab(TRANSIENT));
    const gone = await render(seen, [], [ended], false);
    expect([gone.holding, gone.closingTab, seen.asks, seen.closedTabs]).toEqual([null, null, [], []]);
  });

  test("what the phone does after the close moves to the placed tab, and runs when that close goes ahead (#1478)", async () => {
    const seen = fresh();
    const left: string[] = [];
    const first = await render(seen, alone, [terminal], true);
    first.afterClose.current = { key: TRANSIENT, leave: () => left.push("left") };
    await act(async () => first.closeTab(TRANSIENT));
    const answered = await render(seen, placed, [terminal], false);
    expect(answered.afterClose.current?.key).toBe(placedKey);
    answered.closed(placedKey);
    expect([left, answered.afterClose.current]).toEqual([["left"], null]);
  });
});
