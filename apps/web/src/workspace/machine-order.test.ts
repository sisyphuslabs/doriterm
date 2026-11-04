import { describe, expect, test } from "bun:test";
import { arrangeMachines, moveMachine } from "./machine-order.ts";
import type { MachineEntry } from "./machines.ts";

const machine = (core: string, name: string, local = false): MachineEntry => ({
  id: local ? "local" : `machine:${name}`,
  core,
  name,
  local,
  state: "connected",
  live: 0,
  first: undefined,
});

// The default order, as machineEntries gives it: this machine first, then the added ones by name.
const STUDIO = machine("c-studio", "studio", true);
const ALPHA = machine("c-alpha", "alpha");
const BUILD = machine("c-build", "build");
const names = (entries: readonly MachineEntry[]): readonly string[] => entries.map((entry) => entry.name);

describe("arrangeMachines", () => {
  test("with no stored order the list is the default order", () => {
    expect(names(arrangeMachines([STUDIO, ALPHA, BUILD], null))).toEqual(["studio", "alpha", "build"]);
  });

  test("the stored order names machines by their permanent core id, this machine included", () => {
    expect(names(arrangeMachines([STUDIO, ALPHA, BUILD], ["c-build", "c-studio", "c-alpha"]))).toEqual([
      "build",
      "studio",
      "alpha",
    ]);
  });

  test("a renamed machine keeps its place", () => {
    const renamed = machine("c-alpha", "zz-renamed");
    expect(names(arrangeMachines([STUDIO, renamed, BUILD], ["c-alpha", "c-build", "c-studio"]))).toEqual([
      "zz-renamed",
      "build",
      "studio",
    ]);
  });

  test("a machine whose name reads like a stored id is not taken for it", () => {
    const lookalike = machine("c-other", "c-alpha");
    expect(names(arrangeMachines([STUDIO, lookalike], ["c-alpha", "c-studio"]))).toEqual(["studio", "c-alpha"]);
  });
});

describe("moveMachine", () => {
  test("writes the core ids, not the names, in the new order", () => {
    expect(moveMachine([STUDIO, ALPHA, BUILD], "c-build", 0)(null)).toEqual({
      machine_order: ["c-build", "c-studio", "c-alpha"],
    });
  });
});
