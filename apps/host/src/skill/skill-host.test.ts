import { type JsonValue, SKILL_REQUEST_DOC, type SkillStatus } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerSkillRequest, skillHooks } from "./skill-host.ts";
import { skillTargets } from "./skill-targets.ts";

const DONE: SkillStatus = {
  bundled: "0.1.22",
  dirs: [{ dir: "~/.agents/skills", state: "installed", version: "0.1.22" }],
};

/** One core document in memory: `set` is a compare-and-set at the version read. */
function store(initial: JsonValue) {
  let value = initial;
  let version = 1;
  return {
    get: async (name: string) => {
      expect(name).toBe(SKILL_REQUEST_DOC);
      return { value, version };
    },
    set: async (_: string, next: JsonValue, at: number) => {
      if (at !== version) throw new Error("conflict");
      value = next;
      version += 1;
      return { version };
    },
    value: () => value,
  };
}

describe("answerSkillRequest", () => {
  test("a request installs once and is answered in place with the status after", async () => {
    const doc = store({ request: "r1" });
    let installs = 0;
    const skill = { install: async () => ((installs += 1), { status: DONE, failures: [] }) };
    expect(await answerSkillRequest(doc, skill)).toBe("answered");
    expect(doc.value()).toEqual({ request: "r1", done: DONE });
    // The host's own answer comes back as a doc event: it installs nothing again.
    expect(await answerSkillRequest(doc, skill)).toBe("skipped");
    expect(installs).toBe(1);
  });

  test("a failed install is answered with its error", async () => {
    const doc = store({ request: "r2" });
    const skill = { install: () => Promise.reject(new Error("disk full")) };
    expect(await answerSkillRequest(doc, skill)).toBe("answered");
    expect(doc.value()).toEqual({ request: "r2", error: "disk full" });
  });

  test("a request in flight is not started twice by a second doc event", async () => {
    const doc = store({ request: "r3" });
    const gate = Promise.withResolvers<{ status: SkillStatus; failures: string[] }>();
    let installs = 0;
    const skill = { install: () => ((installs += 1), gate.promise) };
    const answering = new Set<string>();
    const first = answerSkillRequest(doc, skill, answering);
    expect(await answerSkillRequest(doc, skill, answering)).toBe("skipped");
    gate.resolve({ status: DONE, failures: [] });
    expect(await first).toBe("answered");
    expect(installs).toBe(1);
  });

  test.each([null, { request: "" }, "install", { request: "r4", error: "earlier" }])(
    "leaves %p alone",
    async (value) => {
      const doc = store(value);
      expect(await answerSkillRequest(doc, { install: () => Promise.reject(new Error("must not run")) })).toBe(
        "skipped",
      );
      expect(doc.value()).toEqual(value);
    },
  );
});

describe("a directory that failed", () => {
  test("is answered as an error naming it, and the facts are written again since others may have changed", async () => {
    const doc = store({ request: "r5" });
    let refreshed = 0;
    const hooks = skillHooks(
      {
        status: async () => DONE,
        install: async () => ({ status: DONE, failures: ["~/.claude/skills: permission denied"] }),
        refreshOutdated: async () => [],
      },
      () => (refreshed += 1),
      () => {},
    );
    await hooks.answer(doc);
    expect(doc.value()).toEqual({ request: "r5", error: "~/.claude/skills: permission denied" });
    expect(refreshed).toBe(1);
  });

  test("a request event that installs nothing writes no facts", async () => {
    let refreshed = 0;
    const hooks = skillHooks(
      {
        status: async () => DONE,
        install: async () => ({ status: DONE, failures: [] }),
        refreshOutdated: async () => [],
      },
      () => (refreshed += 1),
      () => {},
    );
    await hooks.answer(store({ request: "r6", done: DONE }));
    await hooks.answer(store(null));
    expect(refreshed).toBe(0);
  });
});

describe("skillTargets", () => {
  test("a skills directory linked to another is written once", () => {
    const home = mkdtempSync(join(tmpdir(), "dh-skill-home-"));
    try {
      mkdirSync(join(home, ".agents", "skills"), { recursive: true });
      mkdirSync(join(home, ".claude"));
      symlinkSync(join(home, ".agents", "skills"), join(home, ".claude", "skills"));
      expect(skillTargets(home).map((target) => target.shown)).toEqual(["~/.agents/skills"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  const home = join("/", "home", "demo");
  test("~/.agents/skills always, and ~/.claude/skills only where Claude Code is set up", () => {
    expect(skillTargets(home, [], () => false)).toEqual([
      { path: join(home, ".agents", "skills"), shown: "~/.agents/skills" },
    ]);
    expect(skillTargets(home, [], (path) => path === join(home, ".claude")).map((target) => target.shown)).toEqual([
      "~/.agents/skills",
      "~/.claude/skills",
    ]);
  });

  test("--dir replaces the defaults, once each, shown under ~ when inside home", () => {
    const outside = join("/", "opt", "skills");
    expect(skillTargets(home, [join(home, "x"), outside, outside], () => true)).toEqual([
      { path: join(home, "x"), shown: "~/x" },
      { path: outside, shown: outside },
    ]);
  });
});
