import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IntakeDeps, takeReport } from "./intake.ts";
import type { ProcessFacts } from "./process-facts.ts";
import { ResumeStore } from "./records.ts";

const scratch = mkdtempSync(join(tmpdir(), "resume-intake-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TOKEN = "token-of-the-terminal-t1";
const NOW = 1795543200;
const UID = 1000;
const ROOT = 100;
let dirs = 0;

/** Process 100 is the terminal's shell, 101 a program in it, 200 another tree's, 300 another user's. */
const FACTS: Readonly<Record<number, ProcessFacts>> = {
  100: { uid: UID, ppid: 1, started: "s100", cwd: "/home/user" },
  101: { uid: UID, ppid: 100, started: "s101", cwd: "/home/user/src" },
  200: { uid: UID, ppid: 1, started: "s200", cwd: "/" },
  300: { uid: UID + 1, ppid: 100, started: "s300", cwd: "/" },
};

function setup(limit?: number) {
  const store = ResumeStore.open(join(scratch, `s${(dirs += 1)}`), limit);
  store.track("t1", { token: TOKEN, name: null, env: {} });
  const logs: string[] = [];
  const deps: IntakeDeps = {
    store,
    factsOf: (pid) => Promise.resolve(FACTS[pid]),
    nowS: () => NOW,
    uid: UID,
    log: (line) => logs.push(line),
  };
  const take = (body: string, address = "t1") => takeReport(deps, address, ROOT, new TextEncoder().encode(body));
  return { store, take, logs };
}
const b64 = (text: string): string => Buffer.from(text).toString("base64");
const signed = (rest: string, token = TOKEN): string =>
  `${rest}:mac=${createHash("sha256").update(`${rest}:${token}`).digest("hex")}`;
const report = (pid: number, extra = ""): string => signed(`pid=${pid}:time=${NOW}:argv=${b64("nvim")}${extra}`);

describe("takeReport", () => {
  test("a good report from a program in the terminal becomes its record, with the program's cwd", async () => {
    const { store, take } = setup();
    expect(await take(report(101))).toBe("accepted");
    expect(store.entry("t1")?.record).toEqual({
      argv: ["nvim"],
      cwd: "/home/user/src",
      cwdReported: false,
      pid: 101,
      started: "s101",
      firstProcess: false,
      time: NOW,
      uid: UID,
    });
  });

  test("the report's own cwd wins, and the terminal's first process is marked so", async () => {
    const { store, take } = setup();
    expect(await take(report(100, `:cwd=${b64("/srv/project")}`))).toBe("accepted");
    expect(store.entry("t1")?.record).toMatchObject({ cwd: "/srv/project", cwdReported: true, firstProcess: true });
  });

  test("a report with a wrong or missing mac changes nothing, even the record it names", async () => {
    const { store, take } = setup();
    await take(report(101));
    const rest = `pid=101:time=${NOW}:argv=${b64("./evil")}`;
    expect(await take(signed(rest, "another-terminals-token"))).toBe("ignored");
    expect(await take(rest)).toBe("ignored");
    expect(store.entry("t1")?.record?.argv).toEqual(["nvim"]);
  });

  test("a report for a terminal the host did not start is ignored", async () => {
    const { store, take } = setup();
    expect(await take(report(101), "t9")).toBe("ignored");
    expect(store.entry("t9")).toBeUndefined();
  });

  test("a rejected report removes its owner's record", async () => {
    const { store, take } = setup();
    await take(report(101));
    expect(await take(signed(`pid=101:time=${NOW}:argv=${b64("./run.sh")}`))).toBe("rejected");
    expect(store.entry("t1")?.record).toBeUndefined();
  });

  test("after an accepted clear, a replay of the program's earlier report inside the window is ignored", async () => {
    const { store, take } = setup();
    const earlier = report(101);
    expect(await take(earlier)).toBe("accepted");
    expect(await take(signed(`pid=101:time=${NOW + 1}:clear=1`))).toBe("cleared");
    expect(await take(earlier)).toBe("ignored");
    expect(store.entry("t1")?.record).toBeUndefined();
  });

  test("clear removes the owner's record", async () => {
    const { store, take } = setup();
    await take(report(101));
    expect(await take(signed(`pid=101:time=${NOW}:clear=1`))).toBe("cleared");
    expect(store.entry("t1")?.record).toBeUndefined();
  });

  for (const [what, pid] of [
    ["a pid that is not running", 999],
    ["a pid outside the terminal's process tree", 200],
    ["a pid that runs as another user", 300],
  ] as const) {
    test(`${what} is rejected and keeps no record`, async () => {
      const { store, take, logs } = setup();
      expect(await take(report(pid))).toBe("rejected");
      expect(store.entry("t1")?.record).toBeUndefined();
      expect(logs.join("\n")).toContain(`pid ${pid}`);
    });
  }

  test("past the record limit a report is rejected", async () => {
    const { store, take } = setup(0);
    expect(await take(report(101))).toBe("rejected");
    expect(store.entry("t1")?.record).toBeUndefined();
  });
});
