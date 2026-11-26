import { expect, test } from "bun:test";
import { type GridSize, HostSize, type SizedStream } from "./host-size.ts";

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

/**
 * The core's side, as herdr-core's viewers.rs keeps it: the pty takes the size of the viewer that resized or gained
 * focus last. Nothing here runs on a clock, so every exchange settles as it is made.
 */
function core() {
  const sizes = new Map<string, GridSize>();
  const frames: string[] = [];
  let pty: GridSize | null = null;
  const viewer = (id: string): SizedStream => ({
    resize: (cols, rows) => {
      sizes.set(id, { cols, rows });
      pty = { cols, rows };
      frames.push(`${id} resize ${cols}x${rows}`);
      return true;
    },
    focus: (gained) => {
      frames.push(`${id} focus ${gained}`);
      if (gained) pty = sizes.get(id) ?? pty;
      return true;
    },
  });
  return { viewer, frames, pty: () => pty };
}

test("two desks of different sizes settle on the one used last, one frame per action and none resent (#2672 review)", () => {
  const host = core();
  const [a, b] = [host.viewer("a"), host.viewer("b")];
  const [deskA, deskB] = [new HostSize(false), new HostSize(false)];
  deskA.resize(a, 120, 30);
  deskA.focus(a, true);
  deskB.resize(b, 80, 50);
  deskB.focus(b, true);
  // Each desk sends only for its own grid change and its own focus: the size the other one gave the pty is no reason to
  // send, so the two never trade the size back and forth.
  expect(host.frames).toEqual(["a resize 120x30", "a focus true", "b resize 80x50", "b focus true"]);
  expect(host.pty()).toEqual({ cols: 80, rows: 50 });
  deskA.focus(a, true);
  expect(host.pty()).toEqual({ cols: 120, rows: 30 });
  expect(host.frames).toHaveLength(5);
});

test("a phone that starts typing keeps its size against a desk that stays focused but idle (D1)", () => {
  const host = core();
  const [desk, phone] = [host.viewer("desk"), host.viewer("phone")];
  const deskSize = new HostSize(false);
  deskSize.resize(desk, 120, 30);
  deskSize.focus(desk, true);
  const phoneSize = new HostSize(true);
  phoneSize.resize(phone, 40, 30);
  phoneSize.focus(phone, true);
  // Only watching, the phone leaves the desk its size.
  expect(host.pty()).toEqual({ cols: 120, rows: 30 });
  phoneSize.inputStarts(phone, { cols: 40, rows: 30 });
  expect(host.pty()).toEqual({ cols: 40, rows: 30 });
  // The desk keeps its focus and sends nothing more, so the typing phone keeps the size until the desk is used again.
  expect(host.frames.filter((frame) => frame.startsWith("desk"))).toEqual(["desk resize 120x30", "desk focus true"]);
});
