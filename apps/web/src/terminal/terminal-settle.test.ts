import { HcRpcError } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import {
  type CoreAnswer,
  restartOnReattach,
  settled,
  type Settled,
  type Unsent,
  unsentReason,
} from "./terminal-settle.ts";

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

describe("restartOnReattach", () => {
  // #2303: the reattach that finds another program drops what was typed for the old one and says so.
  const cases: readonly [string, boolean, number | null | undefined, number, boolean, Unsent][] = [
    ["a first attach, whatever runs there", false, PROGRAM + 1, 1, false, null],
    ["a reattach to the same program", true, PROGRAM, 1, false, null],
    ["a reattach to another program, with input waiting", true, PROGRAM + 1, 2, true, "restarted"],
    ["a reattach to another program, nothing waiting", true, PROGRAM + 1, 0, true, null],
    ["a reattach that finds the program lost, with input waiting", true, null, 1, true, "restarted"],
  ];
  test.each(cases)("%s", (_, reattach, pid, waiting, close, unsent) => {
    const pending = Array.from({ length: waiting }, (__, at) => `key-${at}`);
    expect(restartOnReattach(reattach, pid, PROGRAM, pending)).toEqual({ close, unsent });
    // Input for a program that is gone is dropped, never written to the new one.
    expect(pending).toHaveLength(close ? 0 : waiting);
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
