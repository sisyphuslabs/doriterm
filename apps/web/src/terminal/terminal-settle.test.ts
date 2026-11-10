import { HcRpcError } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { type CoreAnswer, settled, type Settled, type Unsent, unsentReason } from "./terminal-settle.ts";

const PROGRAM = 4242;
const live = (pid: number | null): CoreAnswer => ({ terminal: { state: "live", pid } });
const finished: CoreAnswer = { terminal: { state: "finished", pid: null } };
// The error kinds hc answers with: an unknown terminal, and a machine that cannot be reached.
const failed = (kind: string): CoreAnswer => ({
  error: new HcRpcError({ code: -32000, message: kind, data: { kind } }),
});

describe("settled", () => {
  const cases: readonly [string, CoreAnswer, boolean, boolean, Settled][] = [
    ["the core no longer knows it (first attach)", failed("not_found"), true, true, "finished"],
    ["the core no longer knows it (after a drop)", failed("not_found"), false, true, "finished"],
    ["its machine cannot answer (first attach)", failed("unavailable"), true, true, "error"],
    ["its machine cannot answer (after a drop)", failed("unavailable"), false, true, "error"],
    ["it finished before a first attach", finished, true, true, "ended"],
    ["it finished while the line was down", finished, false, true, "finished"],
    ["it finished after its stream was lost", finished, false, false, "ended"],
    ["it is lost, waiting for its new shell", live(null), false, false, "restarting"],
    ["another program runs there now", live(PROGRAM + 1), false, false, "replaced"],
    ["the same program refused the reattach", live(PROGRAM), false, true, "error"],
    ["the program runs but refused a first attach", live(PROGRAM), true, true, "error"],
    ["the same program still runs after a lost stream", live(PROGRAM), false, false, "reattach"],
  ];
  test.each(cases)("%s", (_, answer, first, refused, expected) => {
    expect(settled(answer, PROGRAM, first, refused)).toBe(expected);
  });
});

describe("unsentReason", () => {
  const cases: readonly [string, CoreAnswer, Unsent][] = [
    ["the same program still runs", live(PROGRAM), null],
    ["another program runs there now", live(PROGRAM + 1), "restarted"],
    ["it is lost, waiting for its new shell", live(null), "restarted"],
    ["it finished", finished, "ended"],
    ["the core no longer knows it", failed("not_found"), "ended"],
    ["its machine cannot answer", failed("unavailable"), null],
  ];
  test.each(cases)("%s", (_, answer, expected) => {
    expect(unsentReason(answer, PROGRAM)).toBe(expected);
  });
});
