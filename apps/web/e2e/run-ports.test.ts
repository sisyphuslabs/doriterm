import { expect, test } from "bun:test";
import { bandOutside, ephemeralRange, IANA_DYNAMIC, parsePortRange } from "./ephemeral-range.ts";
import { HOST_BLOCK } from "./port-block.ts";
import { ensureRunPorts } from "./run-ports.ts";
import { parseTried, portsToProbe } from "./run-ports.ts";

const NAMES = ["E2E_HOST_PORT", "E2E_WEB_PORT", "E2E_LAYOUT_PORT"] as const;

// A port in the ephemeral range can be taken between the pick and the host's listen by any outgoing connection's local
// end, and a worker host then exits on "already in use" for every test its slot runs (#862: 52 failures at 124638e6).
test("the run's ports are none the OS hands out by itself", () => {
  const saved = NAMES.map((name) => process.env[name]);
  for (const name of NAMES) delete process.env[name];
  try {
    ensureRunPorts();
    const [host, web, layout] = NAMES.map((name) => Number(process.env[name]));
    const ports = [...Array.from({ length: HOST_BLOCK }, (_, slot) => (host ?? 0) + slot), web, layout];
    const { first, last } = ephemeralRange();
    expect(ports.filter((value) => value === undefined || (value >= first && value <= last))).toEqual([]);
    expect(new Set(ports).size).toBe(HOST_BLOCK + 2);
  } finally {
    NAMES.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test("the ephemeral range is read from Linux's file or from the two sysctl lines", () => {
  expect(parsePortRange("32768\t60999\n")).toEqual({ first: 32768, last: 60999 });
  expect(parsePortRange("49152\n65535\n")).toEqual({ first: 49152, last: 65535 });
  expect(parsePortRange("")).toBeUndefined();
  expect(parsePortRange("60999 32768")).toBeUndefined();
  expect(parsePortRange("1 2 3")).toBeUndefined();
  expect(IANA_DYNAMIC).toEqual({ first: 49152, last: 65535 });
});

test("the band sits below the ephemeral range, above it when there is no room below, and refuses with neither", () => {
  expect(bandOutside({ first: 32768, last: 60999 }, 34)).toEqual({ first: 10_000, last: 32767 });
  expect(bandOutside({ first: 10_050, last: 60000 }, 34)).toEqual({ first: 60001, last: 65535 });
  expect(() => bandOutside({ first: 1024, last: 65535 }, 34)).toThrow("no room for 34 consecutive ports");
});

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
