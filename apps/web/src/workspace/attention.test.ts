import { describe, expect, test } from "bun:test";
import {
  agentStatus,
  attentionMark,
  marksInView,
  nextNeedingYou,
  someoneElseNeedsYou,
  panesInView,
  type Session,
  withAttention,
} from "./attention.ts";
import { groupAgents } from "./model.ts";

const session = (fields: Partial<Session> = {}): Session => ({
  address: "t1",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/doriface",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

describe("agentStatus", () => {
  test.each([
    ["never reported", {}, "idle"],
    ["reported, now silent", { reported: true, status: null }, "idle"],
    ["working", { reported: true, status: { state: "working" } }, "working"],
    ["blocked", { reported: true, status: { state: "blocked" } }, "blocked"],
    ["error reads as needing you", { reported: true, status: { state: "error" } }, "blocked"],
    ["done", { reported: true, status: { state: "done" } }, "done"],
    ["a word outside the protocol", { reported: true, status: { state: "thinking" } }, "idle"],
    ["an Object.prototype name", { reported: true, status: { state: "constructor" } }, "idle"],
    ["finished", { state: "finished" }, "done"],
  ] as const)("%s -> %s", (_name, fields, expected) => {
    expect(agentStatus(session(fields))).toBe(expected);
  });

  test("a finish this screen has looked at reads idle, and no other word changes for it", () => {
    expect(agentStatus(session({ status: { state: "done" }, seen: true }))).toBe("idle");
    expect(agentStatus(session({ state: "finished", seen: true }))).toBe("idle");
    expect(agentStatus(session({ status: { state: "working" }, seen: true }))).toBe("working");
    expect(agentStatus(session({ status: { state: "blocked" }, seen: true }))).toBe("blocked");
  });

  test("the sidebar section and the selector agree for every terminal", () => {
    const terminals = [
      session({ address: "t1" }),
      session({ address: "t2", status: { state: "working" } }),
      session({ address: "t3", status: { state: "blocked" } }),
      session({ address: "t4", status: { state: "done" }, seen: true }),
    ];
    const groups = groupAgents(terminals, 0);
    for (const entry of terminals) {
      const status = agentStatus(entry);
      const section = status === "unknown" ? [] : groups[status];
      expect(section.map((agent) => agent.id)).toContain(entry.address);
    }
  });
});

describe("attentionMark", () => {
  test("a done word asks for the turn it finished in, a finished terminal for when it finished, nothing else does", () => {
    expect(attentionMark(session({ status: { state: "done" }, turn: 3 }))).toBe("3");
    expect(attentionMark(session({ state: "finished", finished_ms: 77 }))).toBe("77");
    expect(attentionMark(session({ status: { state: "working" }, turn: 3 }))).toBeNull();
    expect(attentionMark(session({ status: { state: "blocked" }, turn: 3 }))).toBeNull();
    expect(attentionMark(session({ status: { state: "error" }, turn: 3 }))).toBeNull();
    expect(attentionMark(session())).toBeNull();
  });

  test("the mark is the turn, not status_ms, which a status event does not carry", () => {
    expect(attentionMark(session({ status: { state: "done" }, status_ms: 41, turn: 2 }))).toBe("2");
  });

  test("a done word with no turn of its own still marks one, so a screen can record having seen it", () => {
    expect(attentionMark(session({ status: { state: "done" } }))).toBe("0");
  });

  test("a terminal whose machine cannot be reached shows nothing yet, so it is not looked at", () => {
    expect(attentionMark(session({ offline: true, status: { state: "done" }, turn: 3 }))).toBeNull();
  });
});

describe("withAttention", () => {
  test("a finished agent whose finish the screen has seen reads idle; its next turn asks again", () => {
    const seen: Session[] = [session({ status: { state: "done" }, turn: 3 })];
    const [looked] = withAttention(seen, { t1: "3" });
    expect(looked === undefined ? null : agentStatus(looked)).toBe("idle");
    const again = [session({ status: { state: "done" }, turn: 4 })];
    const [raised] = withAttention(again, { t1: "3" });
    expect(raised === undefined ? null : agentStatus(raised)).toBe("done");
  });

  test("a terminal nobody has seen, and a list with nothing to mark, are returned untouched", () => {
    const terminals = [session({ status: { state: "done" }, turn: 3 })];
    expect(withAttention(terminals, {})).toBe(terminals);
    expect(withAttention(terminals, { t1: "2" })).toBe(terminals);
    const [kept] = withAttention(terminals, {});
    expect(kept).toBe(terminals[0]);
  });

  test("only the terminals whose own finish was seen change, and the others are the same objects", () => {
    const terminals = [
      session({ address: "t1", status: { state: "done" }, turn: 3 }),
      session({ address: "t2", status: { state: "done" }, turn: 4 }),
      session({ address: "t3", status: { state: "working" }, turn: 5 }),
    ];
    const shown = withAttention(terminals, { t1: "3", t2: "3", t3: "5" });
    expect(shown.map(agentStatus)).toEqual(["idle", "done", "working"]);
    expect(shown[1]).toBe(terminals[1]);
    expect(shown[2]).toBe(terminals[2]);
  });
});

describe("panesInView", () => {
  const tab = {
    panes: [
      { id: "p1", address: "t1" },
      { id: "p2", address: "t2" },
      { id: "p3", address: null },
    ],
  };

  test("every pane of the tab in view is shown, or only the zoomed one", () => {
    expect(panesInView(tab, null)).toEqual(["t1", "t2"]);
    expect(panesInView(tab, "p2")).toEqual(["t2"]);
    expect(panesInView(tab, "p3")).toEqual([]);
    expect(panesInView(null, null)).toEqual([]);
  });
});

describe("marksInView", () => {
  test("the finishes among the terminals this screen shows, by address, and nothing for the others", () => {
    const terminals = [
      session({ address: "t1", status: { state: "done" }, turn: 3 }),
      session({ address: "t2", state: "finished", finished_ms: 42 }),
      session({ address: "t3", status: { state: "blocked" }, turn: 5 }),
    ];
    expect(marksInView(terminals, ["t1", "t3", "t4"])).toEqual({ t1: "3" });
    expect(marksInView(terminals, ["t2"])).toEqual({ t2: "42" });
    expect(marksInView(terminals, [])).toEqual({});
  });
});

describe("nextNeedingYou", () => {
  const blocked = { status: { state: "blocked" } } as const;
  const terminals = [
    session({ address: "a" }),
    session({ address: "b", ...blocked }),
    session({ address: "c", status: { state: "working" } }),
    session({ address: "d", ...blocked }),
  ];

  test.each([
    ["nothing in focus: the first that needs you", null, "b"],
    ["after a terminal that does not need you", "a", "b"],
    ["after one that needs you: the next one", "b", "d"],
    ["past a working one", "c", "d"],
    ["after the last: round to the first", "d", "b"],
    ["focus on a terminal that is gone", "zz", "b"],
  ] as const)("%s", (_name, focused, expected) => {
    expect(nextNeedingYou(terminals, focused)).toBe(expected);
  });

  test("the only one that needs you is itself the next, even in focus", () => {
    const one = [session({ address: "a" }), session({ address: "b", ...blocked })];
    expect(nextNeedingYou(one, "b")).toBe("b");
  });

  test("none when nobody waits, and an offline or ended terminal never counts", () => {
    expect(nextNeedingYou([session({ address: "a" })], null)).toBeNull();
    expect(nextNeedingYou([session({ address: "a", ...blocked, offline: true })], null)).toBeNull();
    expect(nextNeedingYou([session({ address: "a", ...blocked, state: "finished" })], null)).toBeNull();
    expect(nextNeedingYou([], "a")).toBeNull();
  });
});

describe("someoneElseNeedsYou", () => {
  const blocked = { status: { state: "blocked" } } as const;

  test("only the terminal in view needs you: nobody else to open, so the palette lists no row (#1448)", () => {
    const one = [session({ address: "a" }), session({ address: "b", ...blocked })];
    expect(someoneElseNeedsYou(one, "b")).toBe(false);
    expect(someoneElseNeedsYou(one, "a")).toBe(true);
    expect(someoneElseNeedsYou(one, null)).toBe(true);
    expect(someoneElseNeedsYou([session({ address: "a" })], null)).toBe(false);
  });
});

describe("attention across the surfaces", () => {
  test("a seen finish leaves the Done section for Idle, and stops the counts asking for it", () => {
    const terminals = [session({ status: { state: "done" }, turn: 3 })];
    expect(groupAgents(terminals, 0).done.map((agent) => agent.id)).toEqual(["t1"]);
    const looked = groupAgents(withAttention(terminals, { t1: "3" }), 0);
    expect(looked.done).toEqual([]);
    expect(looked.idle.map((agent) => agent.id)).toEqual(["t1"]);
  });
});
