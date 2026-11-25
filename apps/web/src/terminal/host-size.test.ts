import { expect, test } from "bun:test";
import { HostSize, type SizedStream } from "./host-size.ts";

function recorder(): SizedStream & { readonly frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    resize: (cols, rows) => (frames.push(`resize ${cols}x${rows}`), true),
    focus: (gained) => (frames.push(`focus ${gained}`), true),
  };
}

test("a desk viewer sends every resize and focus at once", () => {
  const size = new HostSize(false);
  const stream = recorder();
  expect(size.attachDeferred()).toBe(false);
  size.resize(stream, 80, 24);
  size.focus(stream, true);
  expect(stream.frames).toEqual(["resize 80x24", "focus true"]);
});

test("a touch viewer only watching holds its size and focus back from the host", () => {
  const size = new HostSize(true);
  const stream = recorder();
  expect(size.attachDeferred()).toBe(true);
  size.resize(stream, 40, 30);
  size.resize(stream, 44, 31);
  size.focus(stream, true);
  expect(stream.frames).toEqual([]);
});

test("its first input sends the latest size, then focus, before the input goes", () => {
  const size = new HostSize(true);
  const stream = recorder();
  size.resize(stream, 40, 30);
  size.resize(stream, 44, 31);
  size.focus(stream, true);
  size.inputStarts(stream, { cols: 44, rows: 31 });
  expect(stream.frames).toEqual(["resize 44x31", "focus true"]);
  expect(size.attachDeferred()).toBe(false);
  size.inputStarts(stream, { cols: 44, rows: 31 });
  size.resize(stream, 50, 31);
  expect(stream.frames).toEqual(["resize 44x31", "focus true", "resize 50x31"]);
});

test("while a pinch holds the size, the grid's refits stay here and only the last one goes on release", () => {
  const size = new HostSize(false);
  const stream = recorder();
  size.resize(stream, 40, 30);
  size.hold();
  size.resize(stream, 44, 31);
  size.resize(stream, 48, 33);
  expect(stream.frames).toEqual(["resize 40x30"]);
  size.release(stream);
  expect(stream.frames).toEqual(["resize 40x30", "resize 48x33"]);
  size.hold();
  size.resize(stream, 50, 34);
  size.resize(stream, 48, 33);
  size.release(stream);
  expect(stream.frames).toEqual(["resize 40x30", "resize 48x33"]);
});

test("a blur reaches the host even while watching, and an input with no stream yet is remembered", () => {
  const size = new HostSize(true);
  const stream = recorder();
  size.focus(stream, false);
  expect(stream.frames).toEqual(["focus false"]);
  size.inputStarts(null, { cols: 40, rows: 30 });
  expect(size.attachDeferred()).toBe(false);
});
