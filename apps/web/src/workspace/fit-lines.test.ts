import { describe, expect, test } from "bun:test";
import { fitLines } from "./fit-lines.ts";

/** One unit per character, so widths read as character counts. */
const measure = (text: string): number => [...text].length;

describe("fitLines", () => {
  test("a title that fits stays one line", () => {
    expect(fitLines("short", 10, measure)).toEqual(["short"]);
  });

  test("a longer one breaks between words into two lines", () => {
    expect(fitLines("deploy the pipeline", 12, measure)).toEqual(["deploy the", "pipeline"]);
  });

  test("past two lines the second ends in an ellipsis that fits", () => {
    const lines = fitLines("remote build server deploy pipeline review", 12, measure);
    expect(lines).toEqual(["remote build", "server depl\u2026"]);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(12);
  });

  test("Korean words break between words, and the rest is cut with an ellipsis", () => {
    const lines = fitLines("배포 파이프라인 정리하고 결과 보고하기", 9, measure);
    expect(lines).toEqual(["배포 파이프라인", "정리하고 결과\u2026"]);
  });

  test("a word wider than a line breaks at its characters", () => {
    expect(fitLines("abcdefghijkl", 5, measure)).toEqual(["abcde", "fghi\u2026"]);
  });
});
