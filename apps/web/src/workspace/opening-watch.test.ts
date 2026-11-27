import { expect, test } from "bun:test";
import { type OpeningSeen, placeable, watchOpenings } from "./opening-watch.ts";

const live = { address: "t1", name: "opened-a", state: "live" } as const;
const finished = { ...live, state: "finished" } as const;
const notEnding = (): boolean => false;
const endingT1 = (address: string): boolean => address === "t1";

test("a start's terminal is noted once the feed lists it live, and once this page is ending it", () => {
  const seen: OpeningSeen = { live: false, ended: false };
  const inFlight = new Map([["opened-a", seen]]);
  watchOpenings(inFlight, [], notEnding);
  expect(seen).toEqual({ live: false, ended: false });
  watchOpenings(inFlight, [live], notEnding);
  expect(seen).toEqual({ live: true, ended: false });
  watchOpenings(inFlight, [live], endingT1);
  expect(seen).toEqual({ live: true, ended: true });
});

test("the run's answer places a terminal that is live, or never seen live (the answer came first, or it failed at launch)", () => {
  expect(placeable({ live: false, ended: false }, [], "t1", notEnding)).toBe(true);
  expect(placeable({ live: true, ended: false }, [live], "t1", notEnding)).toBe(true);
  expect(placeable({ live: false, ended: false }, [finished], "t1", notEnding)).toBe(true);
});

test("the run's answer places no tab for a terminal closed or ended before it came (#2913)", () => {
  expect(placeable({ live: true, ended: false }, [], "t1", notEnding)).toBe(false);
  expect(placeable({ live: true, ended: false }, [finished], "t1", notEnding)).toBe(false);
  expect(placeable({ live: true, ended: true }, [live], "t1", notEnding)).toBe(false);
  expect(placeable({ live: true, ended: false }, [live], "t1", endingT1)).toBe(false);
});
