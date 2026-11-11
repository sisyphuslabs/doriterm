import { afterEach, expect, jest, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { UnprovenLinks } from "../connection/wake.ts";
import { type Dropped, HeldInput, HOLD_BYTES, HOLD_MS, type InputSink } from "./held-input.ts";
import { MachineLines } from "./machine-lines.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

// #2003 (DORITERM-15): input that waits for a stream after the connection dropped is held as input for an added
// machine's line is (#1489): at most HOLD_MS and HOLD_BYTES, Ctrl+C first.

afterEach(() => jest.useRealTimers());

const link = {} as HcConnection;

function droppedConnection(links = new UnprovenLinks(), open = false) {
  const took: TerminalInput[] = [];
  let sink: InputSink | null = open ? { write: (data) => (took.push(data), true) } : null;
  const dropped: [Dropped, string | undefined][] = [];
  const held = new HeldInput(
    links,
    () => link,
    () => sink,
    { lines: new MachineLines(), machine: () => undefined, dropped: (why, name) => dropped.push([why, name]) },
  );
  const unwatch = held.watch();
  /** The view reattached: the new stream takes what waited, oldest first, as use-terminal-attach drains it. */
  const reattach = (): void => {
    sink = { write: (data) => (took.push(data), true) };
    for (const data of held.pending.splice(0)) took.push(data);
  };
  const drop = (): void => {
    sink = null;
  };
  return { held, took, dropped, reattach, drop, unwatch };
}

test("keys typed while no stream is open are dropped past HOLD_MS and said to be not sent", () => {
  jest.useFakeTimers();
  const { held, took, dropped, reattach } = droppedConnection();
  held.send("x");
  jest.advanceTimersByTime(HOLD_MS - 1);
  held.send("y");
  expect(dropped).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(dropped).toEqual([["expired", undefined]]);
  expect(held.pending).toEqual([]);
  reattach();
  held.send("z");
  expect(took).toEqual(["z"]);
});

test("more than HOLD_BYTES typed while no stream is open is dropped at once", () => {
  jest.useFakeTimers();
  const { held, dropped } = droppedConnection();
  held.send("a".repeat(HOLD_BYTES));
  expect(dropped).toEqual([]);
  held.send("b");
  expect(dropped).toEqual([["overflow", undefined]]);
  expect(held.pending).toEqual([]);
});

test("keys typed while no stream is open reach the next stream in the order typed, Ctrl+C included (#2303)", () => {
  jest.useFakeTimers();
  const { held, took, dropped, reattach } = droppedConnection();
  // A command typed, then Ctrl+C to cancel it: the program must not get Ctrl+C at an idle prompt and then run it.
  for (const key of ["cmd", "\r", "\u0003", "o", new Uint8Array([0x03])]) held.send(key);
  reattach();
  expect(took).toEqual(["cmd", "\r", "\u0003", "o", new Uint8Array([0x03])]);
  jest.advanceTimersByTime(HOLD_MS);
  expect(dropped).toEqual([]);
});

test("a hold drained by a reattach starts afresh: keys typed in the next outage get their own HOLD_MS", () => {
  jest.useFakeTimers();
  const { held, took, dropped, reattach, drop } = droppedConnection();
  held.send("a");
  jest.advanceTimersByTime(HOLD_MS - 1000);
  reattach();
  drop();
  held.send("b");
  jest.advanceTimersByTime(HOLD_MS - 1);
  expect(dropped).toEqual([]);
  reattach();
  expect(took).toEqual(["a", "b"]);
});

test("keys typed while a wake check runs wait for it untimed; if it fails, they get HOLD_MS for the reconnect (#1370)", () => {
  jest.useFakeTimers();
  const links = new UnprovenLinks();
  const { held, took, dropped, reattach, drop } = droppedConnection(links, true);
  links.start(link);
  held.send("a");
  jest.advanceTimersByTime(HOLD_MS);
  expect([took, dropped]).toEqual([[], []]);
  links.settle(link, false);
  drop();
  jest.advanceTimersByTime(HOLD_MS - 1);
  reattach();
  expect([took, dropped]).toEqual([["a"], []]);
  const later = droppedConnection(links, true);
  links.start(link);
  later.held.send("b");
  links.settle(link, false);
  later.drop();
  jest.advanceTimersByTime(HOLD_MS);
  expect(later.dropped).toEqual([["expired", undefined]]);
});

/** A stream that closes inside its own write, as a socket found CLOSING does: the view clears it, then the write fails. */
function closingDuringWrite(): { readonly held: HeldInput; readonly dropped: [Dropped, string | undefined][] } {
  let sink: InputSink | null = null;
  sink = {
    write: () => {
      sink = null;
      return false;
    },
  };
  const dropped: [Dropped, string | undefined][] = [];
  const held = new HeldInput(
    new UnprovenLinks(),
    () => link,
    () => sink,
    { lines: new MachineLines(), machine: () => undefined, dropped: (why, name) => dropped.push([why, name]) },
  );
  held.watch();
  return { held, dropped };
}

test("a key refused by a stream that closes during its own write waits HOLD_MS like any other (#2266 review)", () => {
  jest.useFakeTimers();
  const { held, dropped } = closingDuringWrite();
  held.send("rm -rf build\r");
  expect(held.pending).toEqual(["rm -rf build\r"]);
  jest.advanceTimersByTime(HOLD_MS);
  expect([held.pending, dropped]).toEqual([[], [["expired", undefined]]]);
});

test("what a refused write leaves waiting counts toward HOLD_BYTES (#2266 review)", () => {
  jest.useFakeTimers();
  const { held, dropped } = closingDuringWrite();
  held.send("a".repeat(HOLD_BYTES));
  held.send("b");
  expect(dropped).toEqual([["overflow", undefined]]);
});

/** Input for a terminal on the added machine "rack", whose line, stream and wake check a test moves by hand. */
function rackInput() {
  const took: TerminalInput[] = [];
  let sink: InputSink | null = { write: (data) => (took.push(data), true) };
  const links = new UnprovenLinks();
  const lines = new MachineLines();
  const dropped: [Dropped, string | undefined][] = [];
  const held = new HeldInput(
    links,
    () => link,
    () => sink,
    { lines, machine: () => "rack", dropped: (why, name) => dropped.push([why, name]) },
  );
  held.watch();
  const line = (state: string) => lines.heard(link, [{ name: "rack", state }]);
  const streamDown = (): void => {
    sink = null;
  };
  return { held, took, dropped, links, line, streamDown };
}

test("a machine's line back while a wake check runs: what waited goes once the check passes, never expires (#2266 review)", () => {
  jest.useFakeTimers();
  const { held, took, dropped, links, line } = rackInput();
  line("unreachable");
  held.send("a");
  jest.advanceTimersByTime(6_000);
  links.start(link);
  line("connected");
  jest.advanceTimersByTime(5_000);
  expect([took, dropped]).toEqual([[], []]);
  links.settle(link, true);
  expect([took, dropped]).toEqual([["a"], []]);
});

test("a machine's line back while the stream is down: the wait goes on for the stream, in this terminal's words, within the same HOLD_MS (#2303)", () => {
  jest.useFakeTimers();
  const { held, dropped, line, streamDown } = rackInput();
  line("unreachable");
  held.send("a");
  streamDown();
  jest.advanceTimersByTime(4_000);
  line("connected");
  // The bound is the input's, not its cause's: the 4 s it waited for the machine count toward it.
  jest.advanceTimersByTime(HOLD_MS - 4_000 - 1);
  expect(dropped).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(dropped).toEqual([["expired", undefined]]);
});

test("another machine's line changing does not restart the drop of input waiting for this terminal's stream (#2266 review 3)", () => {
  jest.useFakeTimers();
  const took: TerminalInput[] = [];
  const lines = new MachineLines();
  const dropped: [Dropped, string | undefined][] = [];
  const held = new HeldInput(
    new UnprovenLinks(),
    () => link,
    () => null,
    { lines, machine: () => undefined, dropped: (why, name) => dropped.push([why, name]) },
  );
  held.watch();
  held.send("rm -rf build\r");
  for (let at = 0; at < 6; at++) {
    lines.heard(link, [{ name: "rack", state: at % 2 === 0 ? "unreachable" : "connecting" }]);
    jest.advanceTimersByTime(9_000);
  }
  expect([took, dropped]).toEqual([[], [["expired", undefined]]]);
});
