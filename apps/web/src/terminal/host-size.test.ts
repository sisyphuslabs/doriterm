import { expect, test } from "bun:test";
import { fitGrid, type GridSize, HostSize, type SizedStream, type ViewGrid } from "./host-size.ts";

function recorder(): SizedStream & { readonly frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    resize: (cols, rows) => (frames.push(`resize ${cols}x${rows}`), true),
    focus: (gained) => (frames.push(`focus ${gained}`), true),
  };
}

/** A grid whose box fits `box`, as wterm's does: a fit, or wterm's own refit while `autoResize` is on, takes the box. */
function grid(box: GridSize): ViewGrid & { readonly resizes: string[] } {
  const resizes: string[] = [];
  const view = {
    resizes,
    autoResize: true,
    cols: 80,
    rows: 24,
    resize(cols: number, rows: number) {
      view.cols = cols;
      view.rows = rows;
      resizes.push(`${cols}x${rows}`);
    },
    fit() {
      if (view.cols !== box.cols || view.rows !== box.rows) view.resize(box.cols, box.rows);
    },
  };
  return view;
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
  size.inputStarts(stream, grid({ cols: 44, rows: 31 }));
  expect(stream.frames).toEqual(["resize 44x31", "focus true"]);
  expect(size.attachDeferred()).toBe(false);
  size.inputStarts(stream, grid({ cols: 44, rows: 31 }));
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
  size.inputStarts(null, grid({ cols: 40, rows: 30 }));
  expect(size.attachDeferred()).toBe(false);
});

test("a watching view draws at the pty's size, follows it, and its first input fits its own box again (#2974)", () => {
  const size = new HostSize(true);
  const stream = recorder();
  const view = grid({ cols: 48, rows: 43 });
  fitGrid(view);
  size.ptySized(stream, view, { cols: 123, rows: 36 });
  // Held at the pty's grid: no fit takes the box's back while it watches.
  fitGrid(view);
  size.ptySized(stream, view, { cols: 100, rows: 30 });
  expect(view.resizes).toEqual(["48x43", "123x36", "100x30"]);
  // A reattach asks for its own box, then draws at the size the core answers with.
  size.asks(view);
  size.ptySized(stream, view, { cols: 100, rows: 30 });
  expect(view.resizes.slice(3)).toEqual(["48x43", "100x30"]);
  expect(stream.frames).toEqual([]);
  size.inputStarts(stream, view);
  expect(view.autoResize).toBe(true);
  expect(view.resizes.at(-1)).toBe("48x43");
  expect(stream.frames).toEqual(["resize 48x43"]);
  // In use, the view's grid is its own: the pty's size the core reports no longer moves it.
  size.ptySized(stream, view, { cols: 123, rows: 36 });
  expect(view.resizes.at(-1)).toBe("48x43");
});

test("a watching view the core gave its own size keeps fitting its box, and each new size reaches the host (#2987)", () => {
  const size = new HostSize(true);
  const stream = recorder();
  const box = { cols: 44, rows: 29 };
  const view = grid(box);
  expect(size.asks(view)).toEqual({ cols: 44, rows: 29 });
  size.ptySized(stream, view, { cols: 44, rows: 29 });
  expect(view.autoResize).toBe(true);
  // The web font arrives: wterm refits the box and reports the grid's new size.
  Object.assign(box, { cols: 38, rows: 31 });
  fitGrid(view);
  size.resize(stream, view.cols, view.rows);
  // The core's size event for the attach's size comes after the resize went: the view still leads.
  size.ptySized(stream, view, { cols: 44, rows: 29 });
  size.ptySized(stream, view, { cols: 38, rows: 31 });
  expect(view.resizes).toEqual(["44x29", "38x31"]);
  expect(stream.frames).toEqual(["resize 38x31"]);
  // Shown again with a box changed meanwhile: the fit's size goes, and nothing is sent for an unchanged one.
  Object.assign(box, { cols: 35, rows: 25 });
  size.shown(stream, view);
  size.resize(stream, view.cols, view.rows);
  size.shown(stream, view);
  expect(stream.frames).toEqual(["resize 38x31", "resize 35x25"]);
  expect(size.attachDeferred()).toBe(true);
});

test("a watching view a desk took the pty from draws at the desk's size, and leads again once the pty is its own", () => {
  const size = new HostSize(true);
  const stream = recorder();
  const box = { cols: 38, rows: 31 };
  const view = grid(box);
  size.asks(view);
  size.ptySized(stream, view, { cols: 38, rows: 31 });
  size.ptySized(stream, view, { cols: 120, rows: 30 });
  expect(view.autoResize).toBe(false);
  // Rotated while the desk leads: the grid stays at the desk's size, and nothing is sent, shown again or not (D1).
  Object.assign(box, { cols: 84, rows: 14 });
  fitGrid(view);
  size.resize(stream, 84, 14);
  size.shown(stream, view);
  expect(view.resizes.at(-1)).toBe("120x30");
  expect(stream.frames).toEqual([]);
  // The desk leaves: the core gives the pty the size this view last gave it, and the view fits its box again.
  size.ptySized(stream, view, { cols: 38, rows: 31 });
  expect(view.autoResize).toBe(true);
  expect(view.resizes.at(-1)).toBe("84x14");
  size.resize(stream, 84, 14);
  expect(stream.frames).toEqual(["resize 84x14"]);
});

/**
 * The core's side, as herdr-core's viewers.rs keeps it: each viewer has a size and the moment it was last active
 * (attached without `resumed`, resized, or focused); the pty takes the size of the most recently active one, a viewer
 * never active counting as the least, and of the latest such viewer on a tie (`apply_size`). Nothing here runs on a
 * clock, so every exchange settles as it is made.
 */
function core() {
  const viewers = new Map<string, { size: GridSize | null; activeAt: number }>();
  const frames: string[] = [];
  let pty: GridSize | null = null;
  let clock = 0;
  const apply = (): void => {
    let leader: { size: GridSize | null; activeAt: number } | undefined;
    for (const each of viewers.values()) if (leader === undefined || each.activeAt >= leader.activeAt) leader = each;
    pty = leader?.size ?? pty;
  };
  const touch = (id: string, size?: GridSize): void => {
    const each = viewers.get(id) ?? { size: null, activeAt: -1 };
    viewers.set(id, { size: size ?? each.size, activeAt: (clock += 1) });
    apply();
  };
  const viewer = (id: string): SizedStream => ({
    resize: (cols, rows) => {
      frames.push(`${id} resize ${cols}x${rows}`);
      touch(id, { cols, rows });
      return true;
    },
    focus: (gained) => {
      frames.push(`${id} focus ${gained}`);
      if (gained) touch(id);
      return true;
    },
  });
  /** An attach: the core answers with the pty's size once it has applied this viewer's. */
  const attach = (id: string, size: GridSize, resumed: boolean): { stream: SizedStream; size: GridSize } => {
    viewers.set(id, { size, activeAt: resumed ? -1 : (clock += 1) });
    apply();
    return { stream: viewer(id), size: pty ?? size };
  };
  const detach = (id: string): void => {
    viewers.delete(id);
    apply();
  };
  return { viewer, attach, detach, frames, pty: () => pty };
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
  phoneSize.inputStarts(phone, grid({ cols: 40, rows: 30 }));
  expect(host.pty()).toEqual({ cols: 40, rows: 30 });
  // The desk keeps its focus and sends nothing more, so the typing phone keeps the size until the desk is used again.
  expect(host.frames.filter((frame) => frame.startsWith("desk"))).toEqual(["desk resize 120x30", "desk focus true"]);
});

/**
 * A desk pane reattached after a blip, not in use. It asked for the grid it had as the attach went (39x20), and the
 * layout settled one column wider (40x20) while the attach was in flight (#2390).
 */
function backgroundReattach(host: ReturnType<typeof core>) {
  const pane = new HostSize(false);
  const box = { cols: 39, rows: 20 };
  const view = grid(box);
  const asked = pane.asks(view);
  const answer = host.attach("pane", asked, true);
  Object.assign(box, { cols: 40 });
  fitGrid(view);
  pane.attached(answer.stream, view, { asked, size: answer.size, reattach: "background" });
  return { pane, stream: answer.stream, view };
}

const paneFrames = (host: ReturnType<typeof core>): string[] => host.frames.filter((frame) => frame.startsWith("pane"));

test("a pane reattached in the background leaves the size to another device in use, and its focus applies its grid (#2390)", () => {
  const host = core();
  const desk = host.viewer("desk");
  const deskSize = new HostSize(false);
  deskSize.resize(desk, 44, 15);
  deskSize.focus(desk, true);
  const { pane, stream } = backgroundReattach(host);
  // The fit that landed during the attach would make the pane the active viewer: it waits for the pane's focus.
  expect(host.pty()).toEqual({ cols: 44, rows: 15 });
  expect(paneFrames(host)).toEqual([]);
  pane.focus(stream, true);
  expect(paneFrames(host)).toEqual(["pane resize 40x20", "pane focus true"]);
  expect(host.pty()).toEqual({ cols: 40, rows: 20 });
});

test("a pane reattached in the background with nobody else on the terminal leads, and a fit during the attach goes at once (#2390)", () => {
  const host = core();
  backgroundReattach(host);
  expect(paneFrames(host)).toEqual(["pane resize 40x20"]);
  expect(host.pty()).toEqual({ cols: 40, rows: 20 });
});

test("a pane in the background leads once the device in use leaves, and gives the core the size it held (#2390)", () => {
  const host = core();
  const desk = host.viewer("desk");
  new HostSize(false).resize(desk, 44, 15);
  const { pane, stream, view } = backgroundReattach(host);
  host.detach("desk");
  // The core gives the pane the size it asked for; the grid it settled on meanwhile follows.
  expect(host.pty()).toEqual({ cols: 39, rows: 20 });
  pane.ptySized(stream, view, { cols: 39, rows: 20 });
  expect(paneFrames(host)).toEqual(["pane resize 40x20"]);
  expect(host.pty()).toEqual({ cols: 40, rows: 20 });
});

test("the pane in use takes the size back at its reattach: its focus, then the fit that landed during the attach", () => {
  const host = core();
  const desk = host.viewer("desk");
  new HostSize(false).resize(desk, 44, 15);
  const pane = new HostSize(false);
  const box = { cols: 39, rows: 20 };
  const view = grid(box);
  const asked = pane.asks(view);
  const answer = host.attach("pane", asked, true);
  Object.assign(box, { cols: 40 });
  fitGrid(view);
  pane.attached(answer.stream, view, { asked, size: answer.size, reattach: "in use" });
  expect(paneFrames(host)).toEqual(["pane focus true", "pane resize 40x20"]);
  expect(host.pty()).toEqual({ cols: 40, rows: 20 });
});
