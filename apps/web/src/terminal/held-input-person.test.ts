import { afterEach, expect, jest, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { UnprovenLinks } from "../connection/wake.ts";
import { HeldInput, HOLD_BYTES, HOLD_MS, type InputSink, streamSink } from "./held-input.ts";
import type { TerminalInput } from "./terminal-view-props.ts";

// Whether the person typed an input goes with it into the queue and out to each write that tries it (#2794): the view's
// sink lets a held replay go only for the person's input, and only as it is written.

afterEach(() => jest.useRealTimers());

const link = {} as HcConnection;

/** A stream that records each write it was offered, taken or not, and refuses while `refusing`. */
function stream() {
  const offered: [TerminalInput, boolean][] = [];
  const state = { refusing: false };
  const sink: InputSink = {
    write: (data, person) => {
      offered.push([data, person]);
      return !state.refusing;
    },
  };
  return { sink, offered, state };
}

function held(sink: () => InputSink | null) {
  const links = new UnprovenLinks();
  const input = new HeldInput(links, () => link, sink);
  return { input, links, unwatch: input.watch() };
}

test("a stream's sink sends the person's input as typed input, and the terminal's answers as automatic input", () => {
  const events: string[] = [];
  let refusing = true;
  const sink = streamSink({
    write: (data) => (events.push(`typed ${String(data)}`), !refusing),
    writeAutomatic: (data) => (events.push(`automatic ${String(data)}`), true),
  });
  expect(sink.write("a", true)).toBe(false);
  refusing = false;
  expect(sink.write("a", true)).toBe(true);
  expect(sink.write("\u001b[O", false)).toBe(true);
  expect(events).toEqual(["typed a", "typed a", "automatic \u001b[O"]);
});

test("each write is told whether the person typed what it writes, the terminal's answers apart", () => {
  const { sink, offered } = stream();
  const { input } = held(() => sink);
  input.send("l", true);
  input.send("\u001b[?62c", false);
  expect(offered).toEqual([
    ["l", true],
    ["\u001b[?62c", false],
  ]);
});

test("a key the stream refused is offered again, still as the person's, when it is retried", () => {
  const { sink, offered, state } = stream();
  const { input, links } = held(() => sink);
  links.start(link);
  input.send("a", true);
  input.send("\u001b[O", false);
  state.refusing = true;
  links.settle(link, true);
  expect(input.pending.map(({ data, person }) => [data, person])).toEqual([
    ["a", true],
    ["\u001b[O", false],
  ]);
  state.refusing = false;
  input.flush();
  expect(offered).toEqual([
    ["a", true],
    ["a", true],
    ["\u001b[O", false],
  ]);
});

test("input dropped as expired takes its mark with it: answers queued after it are written as answers", () => {
  jest.useFakeTimers();
  let sink: InputSink | null = null;
  const { input } = held(() => sink);
  input.send("x", true);
  jest.advanceTimersByTime(HOLD_MS);
  expect(input.pending).toEqual([]);
  input.send("\u001b[?62c", false);
  const later = stream();
  sink = later.sink;
  input.flush();
  expect(later.offered).toEqual([["\u001b[?62c", false]]);
});

test("input dropped as overflow takes its mark with it: answers queued after it are written as answers", () => {
  let sink: InputSink | null = null;
  const { input } = held(() => sink);
  input.send("x".repeat(HOLD_BYTES), true);
  input.send("y", true);
  expect(input.pending).toEqual([]);
  input.send("\u001b[?62c", false);
  const later = stream();
  sink = later.sink;
  input.flush();
  expect(later.offered).toEqual([["\u001b[?62c", false]]);
});
