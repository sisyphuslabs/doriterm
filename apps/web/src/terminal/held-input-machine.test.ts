import { afterEach, expect, jest, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { UnprovenLinks } from "../connection/wake.ts";
import { type Dropped, HeldInput, HOLD_BYTES, HOLD_MS, type InputSink } from "./held-input.ts";
import { MachineLines } from "./machine-lines.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

afterEach(() => jest.useRealTimers());

const link = {} as HcConnection;

function machineInput(machine: string | undefined) {
  const took: TerminalInput[] = [];
  const sink: InputSink = { write: (data) => (took.push(data), true) };
  const lines = new MachineLines();
  const dropped: [Dropped, string][] = [];
  const held = new HeldInput(
    new UnprovenLinks(),
    () => link,
    () => sink,
    { lines, machine: () => machine, dropped: (why, name) => dropped.push([why, name]) },
  );
  const unwatch = held.watch();
  const line = (state: string) => lines.heard(link, [{ name: "rack", state }]);
  return { held, took, dropped, line, unwatch };
}

test("keys typed while the machine's line is down wait, then reach the stream once, Ctrl+C first (#1489)", () => {
  jest.useFakeTimers();
  const { held, took, dropped, line } = machineInput("rack");
  line("connected");
  held.send("a");
  line("connecting");
  for (const key of ["o", "m", new Uint8Array([0x03]), "\u0003", "o"]) held.send(key);
  line("unreachable");
  expect(took).toEqual(["a"]);

  line("connected");
  expect(took).toEqual(["a", new Uint8Array([0x03]), "\u0003", "o", "m", "o"]);
  expect(held.pending).toEqual([]);
  // Nothing is held any more, so the drop that was due never comes and nothing is written twice.
  jest.advanceTimersByTime(HOLD_MS);
  line("connected");
  held.send("k");
  expect(took).toEqual(["a", new Uint8Array([0x03]), "\u0003", "o", "m", "o", "k"]);
  expect(dropped).toEqual([]);
});

test("keys held past HOLD_MS are dropped and said to be not sent; keys after the line is back go through", () => {
  jest.useFakeTimers();
  const { held, took, dropped, line } = machineInput("rack");
  line("unreachable");
  held.send("x");
  jest.advanceTimersByTime(HOLD_MS - 1);
  held.send("y");
  expect(dropped).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(dropped).toEqual([["expired", "rack"]]);
  expect(held.pending).toEqual([]);

  line("connected");
  held.send("z");
  expect(took).toEqual(["z"]);
});

test("more than HOLD_BYTES held is dropped at once, and the next key starts a new hold", () => {
  jest.useFakeTimers();
  const { held, took, dropped, line } = machineInput("rack");
  line("connecting");
  held.send("a".repeat(HOLD_BYTES - 3));
  held.send("한");
  expect(dropped).toEqual([]);
  held.send("b");
  expect(dropped).toEqual([["overflow", "rack"]]);
  expect(held.pending).toEqual([]);

  held.send("c");
  line("connected");
  expect(took).toEqual(["c"]);
});

test("a terminal on the page's own machine, or an added machine not listed yet, is written at once", () => {
  const own = machineInput(undefined);
  own.line("unreachable");
  own.held.send("a");
  expect(own.took).toEqual(["a"]);

  const unlisted = machineInput("tablet");
  unlisted.line("unreachable");
  unlisted.held.send("b");
  expect(unlisted.took).toEqual(["b"]);
});

test("a view that stopped watching drops no hold and writes nothing when the line comes back", () => {
  jest.useFakeTimers();
  const { held, took, dropped, line, unwatch } = machineInput("rack");
  line("connecting");
  held.send("a");
  unwatch();
  jest.advanceTimersByTime(HOLD_MS);
  line("connected");
  expect([took, dropped]).toEqual([[], []]);
});
