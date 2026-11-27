// #2670 item 1: a space made for a terminal with no space of its own is named after the work its first terminal does
// — its directory when that names a task, else the program it started — never a generic Home.
import type { JsonObject, Terminal } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { guessedSpace, HOME_SPACE, placeOf } from "./placement.ts";

const terminal = (fields: Partial<Terminal> = {}): Terminal => ({
  address: "t1",
  argv: ["sh"],
  cols: 80,
  rows: 24,
  created_ms: 0,
  cwd: "/",
  labels: {},
  screen: "exact",
  state: "live",
  ...fields,
});

const doc = (spaces: readonly { id: string; name: string; folder: string }[]): JsonObject => ({
  spaces: spaces.map((space) => ({ ...space, tabs: [] })),
});

describe("placeOf (#2670)", () => {
  test("a terminal with no space of its own makes a space for its directory: it keeps the folder and saves no name, so it is named after it", () => {
    expect(placeOf(null, terminal({ cwd: "/home/lo/doriterm-2670" }), () => "spc1")).toEqual({
      id: "spc1",
      folder: "/home/lo/doriterm-2670",
    });
  });

  test("a second terminal under that directory joins the space the first made, by its folder", () => {
    const made = doc([{ id: "spc1", name: "", folder: "/home/lo/doriterm-2670" }]);
    expect(placeOf(made, terminal({ address: "t2", cwd: "/home/lo/doriterm-2670/src" }), () => "spc9").id).toBe("spc1");
  });

  test("a terminal in a system directory makes a folderless space named after its program, never Home", () => {
    expect(placeOf(null, terminal({ cwd: "/root", argv: ["/usr/bin/omo"] }), () => "spc2")).toEqual({
      id: "spc2",
      folder: "",
      name: "omo",
    });
  });

  test("later terminals in a system directory join the folderless space named after their program", () => {
    const made = doc([{ id: "spc2", name: "omo", folder: "" }]);
    expect(placeOf(made, terminal({ address: "t2", cwd: "/root", argv: ["/usr/bin/omo"] }), () => "spc9").id).toBe(
      "spc2",
    );
  });

  test("an existing Home space is still the one terminals with no space of their own join (herdr-app's fallback)", () => {
    const home = doc([{ id: "spc-h", name: HOME_SPACE, folder: "" }]);
    expect(placeOf(home, terminal({ cwd: "/home/lo/anything" }), () => "spc9").id).toBe("spc-h");
  });
});

describe("guessedSpace: the guess before a placed tab's write (#2481 review)", () => {
  test("a space the write would make is guessed with the empty id, so it never matches a space the write makes", () => {
    let asked = 0;
    const made = guessedSpace((_doc, makeId) => {
      asked += 1;
      return { id: makeId("spc"), folder: "", name: "Work" };
    }, null);
    expect(made).toEqual({ id: "", folder: "", name: "Work" });
    expect(asked).toBe(1);
  });

  test("an existing space is guessed by its own id", () => {
    expect(guessedSpace(() => ({ id: "spc1", folder: "/w" }), null)).toEqual({ id: "spc1", folder: "/w" });
  });

  test("a tab nothing places is not guessed", () => {
    expect(guessedSpace(undefined, null)).toBeUndefined();
  });
});
