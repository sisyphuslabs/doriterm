import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ResumeRecord, ResumeStore } from "./records.ts";

const scratch = mkdtempSync(join(tmpdir(), "resume-records-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dirs = 0;
const freshDir = (): string => join(scratch, `state-${(dirs += 1)}`);
const TERMINAL = { token: "a".repeat(22), name: "opened-0a1b2c", env: { TERM: "xterm-256color" } };
const record = (pid: number, time = 100): ResumeRecord => ({
  argv: ["nvim", "-S", "/home/user/session.vim"],
  cwd: "/home/user",
  cwdReported: true,
  pid,
  started: "12345",
  firstProcess: false,
  time,
  uid: 1000,
});

describe("ResumeStore", () => {
  test("a terminal and its record survive a reload, in an owner-only dir and file", () => {
    const dir = freshDir();
    const store = ResumeStore.open(dir);
    store.track("t1", TERMINAL);
    expect(store.accept("t1", record(42))).toBe("accepted");
    const again = ResumeStore.open(dir);
    expect(again.entry("t1")).toEqual({ ...TERMINAL, record: record(42), lastTimes: { "42": 100 } });
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "resume.json")).mode & 0o777).toBe(0o600);
    }
  });

  test("a report from a terminal the host did not start is not kept", () => {
    const store = ResumeStore.open(freshDir());
    expect(store.accept("t9", record(42))).toBe("unknown");
    expect(store.entry("t9")).toBeUndefined();
  });

  test("a later report replaces the record; the last accepted time is kept per pid", () => {
    const store = ResumeStore.open(freshDir());
    store.track("t1", TERMINAL);
    store.accept("t1", record(42, 100));
    store.accept("t1", record(43, 105));
    expect(store.entry("t1")?.record?.pid).toBe(43);
    expect(store.lastTime("t1", 42)).toBe(100);
    expect(store.lastTime("t1", 43)).toBe(105);
    expect(store.lastTime("t1", 44)).toBeUndefined();
  });

  test("clear and reject remove the record only when it is that owner's", () => {
    const store = ResumeStore.open(freshDir());
    store.track("t1", TERMINAL);
    store.accept("t1", record(42));
    store.clear("t1", 7);
    store.reject("t1", 7);
    expect(store.entry("t1")?.record?.pid).toBe(42);
    store.clear("t1", 42);
    expect(store.entry("t1")?.record).toBeUndefined();
    store.accept("t1", record(42));
    store.reject("t1", 42);
    expect(ResumeStore.open(store.dir).entry("t1")?.record).toBeUndefined();
  });

  test("past the record limit a new record is refused, while a terminal holding one may still replace it", () => {
    const limit = 3;
    const store = ResumeStore.open(freshDir(), limit);
    for (let index = 0; index < limit; index += 1) {
      store.track(`t${index}`, TERMINAL);
      expect(store.accept(`t${index}`, record(index + 1))).toBe("accepted");
    }
    store.track("t-extra", TERMINAL);
    expect(store.accept("t-extra", record(9999))).toBe("full");
    expect(store.accept("t0", record(5000, 101))).toBe("accepted");
  });

  test("take removes the whole terminal and writes that first, so a relaunch is never retried", () => {
    const store = ResumeStore.open(freshDir());
    store.track("t1", TERMINAL);
    store.accept("t1", record(42));
    expect(store.take("t1")?.record?.pid).toBe(42);
    expect(store.entry("t1")).toBeUndefined();
    expect(ResumeStore.open(store.dir).entry("t1")).toBeUndefined();
  });

  test("forget drops a terminal with its token and record", () => {
    const store = ResumeStore.open(freshDir());
    store.track("t1", TERMINAL);
    store.accept("t1", record(42));
    store.forget("t1");
    expect(ResumeStore.open(store.dir).addresses()).toEqual([]);
  });

  test("an entry that is not well formed is dropped on load; well-formed ones are kept", () => {
    const dir = freshDir();
    ResumeStore.open(dir).track("t1", TERMINAL);
    const good = ResumeStore.open(dir).entry("t1");
    writeFileSync(
      join(dir, "resume.json"),
      JSON.stringify({
        version: 1,
        terminals: {
          t1: good,
          t2: { ...good, token: "short" },
          t3: { ...good, record: { ...record(1), argv: [] } },
          t4: { ...good, record: { ...record(1), argv: ["nvim", "a\nb"] } },
          t5: "nonsense",
        },
      }),
      { mode: 0o600 },
    );
    expect(ResumeStore.open(dir).addresses()).toEqual(["t1"]);
  });

  test("a file of another version starts empty", () => {
    const dir = freshDir();
    ResumeStore.open(dir).track("t1", TERMINAL);
    writeFileSync(join(dir, "resume.json"), JSON.stringify({ version: 99, terminals: {} }), { mode: 0o600 });
    expect(ResumeStore.open(dir).addresses()).toEqual([]);
  });
});
