import { describe, expect, test } from "bun:test";
import { FormatAnswers } from "./format-answers.ts";

describe("FormatAnswers", () => {
  test("keeps what each member said it reads, and its silence as silence", () => {
    const answers = new FormatAnswers();
    answers.record("a", [2, 3]);
    answers.record("b", undefined);
    expect(answers.all()).toEqual([
      { hostId: "a", reads: [2, 3] },
      { hostId: "b", reads: undefined },
    ]);
  });

  test("a later hello replaces the earlier answer, so an upgrade is believed without a restart", () => {
    const answers = new FormatAnswers();
    answers.record("a", [2]);
    answers.record("a", [2, 3]);
    expect(answers.all()).toEqual([{ hostId: "a", reads: [2, 3] }]);
  });
});

describe("answers are dropped when a member leaves the roster", () => {
  test("keep forgets every answer whose member is gone, and keeps the rest", () => {
    const answers = new FormatAnswers();
    answers.record("a", [2, 3]);
    answers.record("gone", [2, 3]);
    answers.keep(new Set(["a"]));
    expect(answers.all().map((answer) => answer.hostId)).toEqual(["a"]);
  });
});
