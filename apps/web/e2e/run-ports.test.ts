import { expect, test } from "bun:test";
import { parseTried, portsToProbe } from "./run-ports.ts";

test("the picker's report is read as base and blocked pairs", () => {
  expect(parseTried('{"tried":[{"base":5000,"blocked":5010},{"base":6000,"blocked":6012}]}')).toEqual([
    { base: 5000, blocked: 5010 },
    { base: 6000, blocked: 6012 },
  ]);
});

test("a report that is not the expected shape yields nothing rather than throwing", () => {
  expect(parseTried("")).toEqual([]);
  expect(parseTried("not json")).toEqual([]);
  expect(parseTried('{"tried":[1,2]}')).toEqual([]);
});

test("both the base and the port that refused it are probed, once each", () => {
  expect(
    portsToProbe([
      { base: 5000, blocked: 5010 },
      { base: 5000, blocked: 5010 },
      { base: 5000, blocked: 5011 },
    ]),
  ).toEqual([5000, 5010, 5011]);
});

test("a block that died on its first port still probes that base", () => {
  expect(portsToProbe([{ base: 5000, blocked: 0 }])).toEqual([5000]);
});
