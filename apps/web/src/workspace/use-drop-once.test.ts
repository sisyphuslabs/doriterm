import { expect, test } from "bun:test";
import { DropOnce } from "./use-drop-once.ts";

const live = (address: string, pid = 10, created_ms = 1_000) => ({ address, state: "live", pid, created_ms });
const finished = (address: string) => ({ address, state: "finished", pid: null, created_ms: 1_000 });

test("a session is dropped once, however many signals report its end", () => {
  const once = new DropOnce();
  once.listed([live("t1")]);
  expect(once.take("t1")).toBe(true);
  expect(once.take("t1")).toBe(false);
});

test("a list that has not heard the end yet still lists the dropped session live: no second drop (#1328)", () => {
  const once = new DropOnce();
  once.listed([live("t1"), live("t2")]);
  expect(once.take("t1")).toBe(true);
  // A machine.list read rebuilds the list from the same held feed, which still has t1 live.
  once.listed([live("t1"), live("t2")]);
  once.listed([live("t1"), live("t2")]);
  // The feed's removal arrives: the dead-pane check reports the same ended session.
  once.listed([live("t2")]);
  expect(once.take("t1")).toBe(false);
});

test("a session listed live after its address was listed not live is a new one, dropped again when it ends", () => {
  for (const between of [[finished("t1")], []]) {
    const once = new DropOnce();
    once.listed([live("t1")]);
    expect(once.take("t1")).toBe(true);
    once.listed(between);
    once.listed([live("t1")]);
    expect(once.take("t1")).toBe(true);
  }
});

test("another program listed live at the dropped address is a new session, dropped again when it ends", () => {
  for (const next of [live("t1", 11), live("t1", 10, 2_000)]) {
    const once = new DropOnce();
    once.listed([live("t1")]);
    expect(once.take("t1")).toBe(true);
    once.listed([next]);
    expect(once.take("t1")).toBe(true);
  }
});

test("a session whose close's End failed keeps running: its later end drops its pane again", () => {
  const once = new DropOnce();
  once.listed([live("t1")]);
  expect(once.take("t1")).toBe(true);
  once.kept("t1");
  once.listed([live("t1")]);
  once.listed([live("t1")]);
  expect(once.take("t1")).toBe(true);
  expect(once.take("t1")).toBe(false);
});

test("a session already listed ended keeps its mark when its close's End still rejects (#1342)", () => {
  const once = new DropOnce();
  once.listed([live("t1")]);
  expect(once.take("t1")).toBe(true);
  // The kill succeeded and the list heard the end, but terminal.rm or the END label call failed: End rejects.
  once.listed([finished("t1")]);
  once.kept("t1");
  expect(once.take("t1")).toBe(false);
});

test("a drop of an address not listed live takes the next live listing there as a new session", () => {
  const once = new DropOnce();
  once.listed([]);
  expect(once.take("t1")).toBe(true);
  once.listed([live("t1")]);
  expect(once.take("t1")).toBe(true);
});
