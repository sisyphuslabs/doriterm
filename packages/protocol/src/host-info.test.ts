import { describe, expect, test } from "bun:test";
import { parseSkillRequestDoc, type SkillStatus } from "./agent-skill.ts";
import { hostInfoFor, parseHostInfo } from "./host-info.ts";

describe("parseHostInfo", () => {
  test.each(["darwin", "linux", "win32"] as const)("reads %s", (os) => {
    expect(parseHostInfo({ v: 1, os })).toEqual({ v: 1, os });
  });

  test("keeps the members it knows from a newer host's document", () => {
    expect(parseHostInfo({ v: 1, os: "darwin", arch: "arm64" })).toEqual({ v: 1, os: "darwin" });
  });

  test.each([
    ["no document", null],
    ["another version", { v: 2, os: "darwin" }],
    ["an OS it does not name", { v: 1, os: "freebsd" }],
    ["no OS", { v: 1 }],
    ["a string", "darwin"],
  ])("refuses %s", (_, value) => {
    expect(parseHostInfo(value)).toBeUndefined();
  });
});

describe("the agent skill in the document", () => {
  const skill: SkillStatus = {
    bundled: "0.1.22",
    dirs: [
      { dir: "~/.agents/skills", state: "installed", version: "0.1.22" },
      { dir: "~/.claude/skills", state: "foreign" },
    ],
  };

  test("is read beside the OS", () => {
    expect(parseHostInfo({ v: 1, os: "linux", skill })).toEqual({ v: 1, os: "linux", skill });
  });

  test.each([
    ["a state it does not name", { bundled: "0.1.22", dirs: [{ dir: "~/x", state: "broken" }] }],
    ["no directory list", { bundled: "0.1.22" }],
    ["a numeric version", { bundled: 22, dirs: [] }],
  ])("with %s is dropped, and the OS still read", (_, value) => {
    expect(parseHostInfo({ v: 1, os: "linux", skill: value })).toEqual({ v: 1, os: "linux" });
  });

  test("a request document is read as a request, an answer or an error", () => {
    expect(parseSkillRequestDoc({ request: "r" })).toEqual({ request: "r" });
    expect(parseSkillRequestDoc({ request: "r", done: skill })).toEqual({ request: "r", done: skill });
    expect(parseSkillRequestDoc({ request: "r", error: "no" })).toEqual({ request: "r", error: "no" });
    expect(parseSkillRequestDoc({ request: "" })).toBeUndefined();
    expect(parseSkillRequestDoc(null)).toBeUndefined();
  });
});

describe("hostInfoFor", () => {
  test("names the three OSes a host reports, and none other", () => {
    expect(hostInfoFor("darwin")).toEqual({ v: 1, os: "darwin" });
    expect(hostInfoFor("win32")).toEqual({ v: 1, os: "win32" });
    expect(hostInfoFor("freebsd")).toBeUndefined();
  });
});
