import { describe, expect, test } from "bun:test";
import {
  HOST_INFO_DOC,
  type JsonValue,
  SKILL_REQUEST_DOC,
  type SkillDirStatus,
  type SkillStatus,
} from "@doriface/protocol";
import { FakeCore, machine } from "../roster/fake-core.test-support.ts";
import { Roster } from "../roster/roster.ts";
import { readSkill, requestSkill, type SkillLink, skillLine } from "./agent-skill.ts";

const dir = (state: SkillDirStatus["state"], version?: string): SkillDirStatus =>
  version === undefined ? { dir: "~/.agents/skills", state } : { dir: "~/.agents/skills", state, version };
const status = (...dirs: SkillDirStatus[]): SkillStatus => ({ bundled: "1.2.0", dirs });

/** A status as the host writes it into a document. */
const json = (value: SkillStatus): JsonValue => ({
  bundled: value.bundled,
  dirs: value.dirs.map((each) => ({ ...each })),
});

describe("the agent skill line a machine's row shows (#2653)", () => {
  test("installed everywhere names the version and offers nothing", () => {
    expect(skillLine(status(dir("installed", "1.2.0")))).toEqual({
      text: "Agent skill installed v1.2.0",
      action: null,
    });
  });

  test("an outdated copy names its version and offers Update", () => {
    expect(skillLine(status(dir("installed", "1.2.0"), dir("outdated", "1.1.0")))).toEqual({
      text: "Agent skill outdated (v1.1.0)",
      action: "update",
    });
  });

  test("a missing copy offers Install, also beside a foreign one, since install writes only the missing", () => {
    const missing = { text: "Agent skill not installed", action: "install" } as const;
    expect(skillLine(status(dir("missing")))).toEqual(missing);
    expect(skillLine(status(dir("foreign"), dir("missing")))).toEqual(missing);
  });

  test("only a foreign copy says Doriterm does not manage it and offers nothing", () => {
    expect(skillLine(status(dir("foreign")))).toEqual({ text: "Agent skill not managed by Doriterm", action: null });
  });

  test("a build without a skill, and a host too old to report one, offer nothing", () => {
    expect(skillLine({ bundled: null, dirs: [dir("missing")] })?.action).toBeNull();
    expect(skillLine(undefined)?.action).toBeNull();
  });
});

/** A roster on the fake core whose timers never fire: only document events move it. */
function linkTo(core: FakeCore): { readonly link: SkillLink; readonly roster: Roster; readonly stop: () => void } {
  const connection = core.connection();
  const roster = new Roster(connection, {
    every: () => () => undefined,
    whenVisible: () => () => undefined,
    schedule: (run) => (queueMicrotask(run), () => undefined),
    now: () => 1_000,
  });
  const stop = roster.subscribe(() => undefined);
  const link: SkillLink = {
    call: connection.call.bind(connection),
    onDoc: (listener) => roster.onDoc(listener),
    onGap: (listener) => roster.onGap(listener),
  };
  return { link, roster, stop };
}

/** Resolves with the request id once a client writes one on `on`, heard through the roster's document events. */
const heardRequest = (core: FakeCore, roster: Roster, on: string | null): Promise<string> =>
  new Promise((resolve) => {
    const stop = roster.onDoc((machineName, name) => {
      const value = core.doc(SKILL_REQUEST_DOC, on).value;
      if (machineName !== on || name !== SKILL_REQUEST_DOC || typeof value !== "object" || value === null) return;
      if (!("request" in value) || "done" in value || "error" in value) return;
      stop();
      resolve(String(value["request"]));
    });
  });

describe("asking a host to install the skill (#2653)", () => {
  test("this computer's host answers done: the request settles with its status", async () => {
    const core = new FakeCore();
    const { link, roster, stop } = linkTo(core);
    const asked = heardRequest(core, roster, null);
    const answer = requestSkill(link, undefined, 2_000, "r-1");
    expect(await asked).toBe("r-1");
    core.setDoc(SKILL_REQUEST_DOC, { request: "r-1", done: json(status(dir("installed", "1.2.0"))) });
    expect(await answer).toEqual(status(dir("installed", "1.2.0")));
    stop();
  });

  test("another client's request written over ours is answered by the same install, so its answer settles ours", async () => {
    const core = new FakeCore();
    const { link, roster, stop } = linkTo(core);
    const asked = heardRequest(core, roster, null);
    const answer = requestSkill(link, undefined, 2_000, "r-5");
    await asked;
    core.setDoc(SKILL_REQUEST_DOC, { request: "r-6" });
    core.setDoc(SKILL_REQUEST_DOC, { request: "r-6", done: json(status(dir("installed", "1.2.0"))) });
    expect(await answer).toEqual(status(dir("installed", "1.2.0")));
    stop();
  });

  test("a machine's host answering an error rejects with its words", async () => {
    const core = new FakeCore();
    core.machines = [machine("build-box")];
    const { link, roster, stop } = linkTo(core);
    const asked = heardRequest(core, roster, "build-box");
    const answer = requestSkill(link, "build-box", 2_000, "r-2");
    await asked;
    core.setDoc(SKILL_REQUEST_DOC, { request: "r-2", error: "Could not write ~/.agents/skills" }, "build-box");
    await expect(answer).rejects.toThrow("Could not write ~/.agents/skills");
    stop();
  });

  test("an answer missed in a gap is read when the feed reports the gap", async () => {
    const core = new FakeCore();
    const { link, roster, stop } = linkTo(core);
    const asked = heardRequest(core, roster, null);
    const answer = requestSkill(link, undefined, 2_000, "r-3");
    await asked;
    core.setDoc(SKILL_REQUEST_DOC, { request: "r-3", done: json(status()) }, null, true);
    core.feeds.at(-1)?.missed();
    expect(await answer).toEqual(status());
    stop();
  });

  test("a host that never answers rejects once the bound passes", async () => {
    const core = new FakeCore();
    const { link, stop } = linkTo(core);
    await expect(requestSkill(link, undefined, 10, "r-4")).rejects.toThrow("The host did not answer");
    stop();
  });

  test("the host's status is read from its doriface-host document, and an offline machine reads as unknown", async () => {
    const core = new FakeCore();
    core.setDoc(HOST_INFO_DOC, { v: 1, os: "linux", skill: json(status(dir("missing"))) }, null, true);
    expect(await readSkill(core.connection(), undefined)).toEqual({ skill: status(dir("missing")) });
    expect(await readSkill(core.connection(), "gone")).toBeNull();
  });
});
