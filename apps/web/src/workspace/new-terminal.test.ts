import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { runParamsFor } from "./new-terminal.ts";

const terminal = (address: string, fields: Partial<Terminal> = {}): Terminal => ({
  address,
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/work/api",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

describe("runParamsFor", () => {
  test("with nothing active the core's defaults apply", () => {
    expect(runParamsFor(undefined)).toEqual({});
  });

  test("starts in the active terminal's directory, its shell's current one when hc reports it", () => {
    expect(runParamsFor(terminal("t1"))).toEqual({ cwd: "/work/api" });
    const moved = terminal("t1", { foreground: { argv: ["sh"], name: "sh", pid: 9, cwd: "/work/api/src" } });
    expect(runParamsFor(moved)).toEqual({ cwd: "/work/api/src" });
  });

  test("with no terminal in focus it starts where the selected space is, on its machine", () => {
    expect(runParamsFor(undefined, { dir: "/srv/api", machine: "build" })).toEqual({ cwd: "/srv/api", on: "build" });
    expect(runParamsFor(undefined, { dir: "" })).toEqual({});
    expect(runParamsFor(terminal("t1"), { dir: "/srv/api" })).toEqual({ cwd: "/work/api" });
  });

  test("the space it is started for is named by herdr.space, so an adoption before its run answers puts it there", () => {
    expect(runParamsFor(undefined, { dir: "", space: "spc1" })).toEqual({ labels: { "herdr.space": "spc1" } });
    expect(runParamsFor(terminal("build/t3", { labels: { space: "infra" } }), { dir: "", space: "spc2" })).toEqual({
      cwd: "/work/api",
      on: "build",
      labels: { space: "infra", "herdr.space": "spc2" },
    });
  });

  test("an active terminal on an added machine starts the new one there, and a named space carries over", () => {
    expect(runParamsFor(terminal("build/t3", { labels: { space: "infra" } }))).toEqual({
      cwd: "/work/api",
      on: "build",
      labels: { space: "infra" },
    });
  });
});
