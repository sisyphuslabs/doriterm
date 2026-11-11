import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HcConnection } from "@doriface/client";
import type { Session } from "./model.ts";

// The first test in apps/web that renders into a DOM. happy-dom is registered in this file only, before react-dom
// loads, and taken away after it, so every other test still runs without a document (#2192).
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => GlobalRegistrator.unregister());
// Each test reads the End of its own render, never one a previous test left behind.
beforeEach(() => {
  onEnded = undefined;
});

/**
 * The End the terminal view was handed by the last render: PhoneTerminal is replaced so it only records it. Bun's
 * mock.module is process-wide and is never undone, so a later test file in the same run imports this stub too: a test
 * of PhoneTerminal itself needs a narrower seam, not this pattern (#2335 review).
 */
let onEnded: ((address: string) => void) | undefined;
mock.module("./phone-terminal.tsx", () => ({
  PhoneTerminal: (props: { readonly onEnded: (address: string) => void }) => {
    onEnded = props.onEnded;
    return null;
  },
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PhoneShell } = await import("./phone-shell.tsx");

const session = (address: string): Session => ({
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

function shell(open: string, onLeave: () => void) {
  return (
    <PhoneShell
      connection={{ hello: {} } as HcConnection}
      terminals={[session("t1"), session("t2")]}
      ids={{ byName: new Map(), byId: new Map() }}
      open={open}
      space={null}
      pushed={false}
      section="agents"
      onSection={() => undefined}
      panes={[open]}
      tabTitle={null}
      onOpen={() => undefined}
      onBack={() => undefined}
      onLeave={onLeave}
      backTo={null}
      onSpaceBack={() => undefined}
      onNew={() => undefined}
      onNewInSpace={() => undefined}
      onCloseTab={() => undefined}
      sheet={false}
      onSheet={() => undefined}
      onPalette={() => undefined}
      onSession={() => false}
    />
  );
}

test("an End that settles after a re-render leaves through the phone's current leave, not its own render's (#2177)", async () => {
  const left: string[] = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(shell("t1", () => left.push("leave when the End began"))));
  const ended = onEnded;
  expect(ended).toBeDefined();
  // The sheet opened or closed while the End was in flight: the phone now leaves another way.
  await act(async () => root.render(shell("t1", () => left.push("leave now"))));
  await act(async () => ended?.("t1"));
  expect(left).toEqual(["leave now"]);
  await act(async () => root.unmount());
});

test("an End for a terminal the phone no longer shows leaves nowhere: the move made meanwhile stands (#1478)", async () => {
  const left: string[] = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(shell("t1", () => left.push("leave"))));
  const ended = onEnded;
  expect(ended).toBeDefined();
  await act(async () => root.render(shell("t2", () => left.push("leave"))));
  await act(async () => ended?.("t1"));
  expect(left).toEqual([]);
  await act(async () => root.unmount());
});
