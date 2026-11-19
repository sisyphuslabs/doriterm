import { describe, expect, test } from "bun:test";
import { guessedSpace } from "./placement.ts";

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
