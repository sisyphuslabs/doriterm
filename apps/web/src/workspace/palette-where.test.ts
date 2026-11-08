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
    expect(agentWhere(terminal({ labels: { space: "web" } }), "studio")).toBe(
      "studio \u203a web \u00b7 /work/doriface",
    );
    expect(agentWhere(terminal({ address: "box/t3", labels: { space: "infra" }, cwd: "/srv" }), "studio")).toBe(
      "box \u203a infra \u00b7 /srv",
    );
  });

  test("the directory is the foreground program's when it moved, and a space with no label is named after it", () => {
    const moved = terminal({
      cwd: "/work/doriface",
      foreground: { argv: ["vim"], cwd: "/work/doriface/apps/web", name: "vim", pid: 7 },
    });
    expect(agentWhere(moved, "studio")).toBe("studio \u203a web \u00b7 /work/doriface/apps/web");
  });
});
