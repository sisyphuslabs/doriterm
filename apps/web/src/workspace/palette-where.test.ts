import type { Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { agentWhere } from "./palette-where.ts";

const terminal = (fields: Partial<Terminal>): Terminal => ({
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

describe("where a palette agent lives (#1465)", () => {
  test("this machine is named as the host; another by its own name", () => {
    expect(agentWhere(terminal({ labels: { space: "web" } }), "studio", undefined)).toEqual({
      place: "studio \u203a web",
      directory: "/work/doriface",
    });
    expect(
      agentWhere(terminal({ address: "box/t3", labels: { space: "infra" }, cwd: "/srv" }), "studio", undefined),
    ).toEqual({ place: "box \u203a infra", directory: "/srv" });
  });

  test("the directory is the foreground program's when it moved, and a space with no label is named after it", () => {
    const moved = terminal({
      cwd: "/work/doriface",
      foreground: { argv: ["vim"], cwd: "/work/doriface/apps/web", name: "vim", pid: 7 },
    });
    expect(agentWhere(moved, "studio", undefined)).toEqual({
      place: "studio \u203a web",
      directory: "/work/doriface/apps/web",
    });
  });

  test("the space is the one the sidebar lists the terminal in, which an unlabeled terminal's folder need not name", () => {
    const adopted = terminal({ address: "t9", cwd: "/work/doriface" });
    expect(agentWhere(adopted, "studio", "Home")).toEqual({ place: "studio \u203a Home", directory: "/work/doriface" });
    expect(agentWhere(adopted, "studio", undefined)).toEqual({
      place: "studio \u203a doriface",
      directory: "/work/doriface",
    });
  });
});
