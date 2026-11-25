import { describe, expect, test } from "bun:test";
import { RateCounter } from "./rate-counter.ts";

describe("RateCounter", () => {
  test("reports zero rates for an empty window", () => {
    const counter = new RateCounter();
    expect(counter.rates(0)).toEqual({ perSecond: 0, uniquePerSecond: 0 });
    expect(counter.rates(5000)).toEqual({ perSecond: 0, uniquePerSecond: 0 });
  });

  test("counts 120 samples spaced 1000/120 ms apart as 120 per second", () => {
    const counter = new RateCounter();
    const step = 1000 / 120;
    for (let i = 0; i < 120; i += 1) {
      counter.add(i, i * step);
    }
    expect(counter.rates(1000)).toEqual({ perSecond: 120, uniquePerSecond: 120 });
  });

  test("counts repeated values only once in uniquePerSecond", () => {
    const counter = new RateCounter();
    const values = [10, 10, 20, 20, 20, 30, 10, 30, 20, 10];
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (value !== undefined) counter.add(value, i * 50);
    }
    expect(counter.rates(500)).toEqual({ perSecond: 10, uniquePerSecond: 3 });
  });

  test("drops samples older than one second from both counts", () => {
    const counter = new RateCounter();
    counter.add(1, 100);
    counter.add(2, 400);
    counter.add(3, 900);
    counter.add(2, 1100);

    // At 1100 ms the sample at 100 ms sits exactly on the 1000 ms boundary and remains in the window.
    expect(counter.rates(1100)).toEqual({ perSecond: 4, uniquePerSecond: 3 });
    // One millisecond later the 100 ms sample falls outside the window.
    expect(counter.rates(1101)).toEqual({ perSecond: 3, uniquePerSecond: 2 });
    // After more than a second past the newest sample, the window empties completely.
    expect(counter.rates(2101)).toEqual({ perSecond: 0, uniquePerSecond: 0 });
  });
});
