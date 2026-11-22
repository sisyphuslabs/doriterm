import { afterEach, beforeEach, expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FakeCore, machine } from "../roster/fake-core.test-support.ts";
import { LINE_READ_MS } from "../roster/line-watch.ts";
import { MACHINE_REFRESH_MS, Roster } from "../roster/roster.ts";
import { MachineLines } from "./machine-lines.ts";
import { useMachineLine } from "./use-machine-line.ts";

// bun test has no DOM: React's client renderer reads `window` and a container, which stand in for exactly that.
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

/** Machine lines on a roster whose timers only record their period: `periods()` lists the reads running now. */
function linesOn(core: FakeCore) {
  const timers: number[] = [];
  const roster = new Roster(core.connection(), {
    every: (_run, ms) => {
      timers.push(ms);
      return () => void timers.splice(timers.indexOf(ms), 1);
    },
    whenVisible: () => () => undefined,
    schedule: (run) => (queueMicrotask(run), () => undefined),
    now: () => 1_000,
  });
  return {
    lines: new MachineLines(() => roster),
    connection: core.connection() as unknown as HcConnection,
    periods: () => timers.toSorted((a, b) => a - b),
  };
}

function Pane(props: { readonly lines: MachineLines; readonly connection: HcConnection; readonly shown: boolean }) {
  useMachineLine(props.connection, "rack/t1", props.shown, props.lines);
  return null;
}

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, window: view });
  root = createRoot(container);
});

afterEach(() => {
  for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) Reflect.deleteProperty(globalThis, key);
});

test("a pane in a hidden tab has its machine's line read only while its tab is shown (#2505 review)", async () => {
  const core = new FakeCore();
  core.machines = [machine("rack")];
  const { lines, connection, periods } = linesOn(core);
  await act(async () => root.render(<Pane lines={lines} connection={connection} shown={false} />));
  expect(periods()).toEqual([]);
  await act(async () => root.render(<Pane lines={lines} connection={connection} shown />));
  expect(periods()).toEqual([LINE_READ_MS, MACHINE_REFRESH_MS]);
  await act(async () => root.render(<Pane lines={lines} connection={connection} shown={false} />));
  expect(periods()).toEqual([]);
  await act(async () => root.unmount());
});
