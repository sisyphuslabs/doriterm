import { describe, expect, test } from "bun:test";
import { laterRank, mergedOrders, orderRank, stampOrder } from "./order.ts";

const rank = (n: number, at = 1, by = "d1") => ({ n, at, by });

describe("which write of the shared machine order a copy holds (#2531)", () => {
  test("a later write counts more writes; the clock and then the device only break a tie between equal counts", () => {
    expect(laterRank(rank(2, 1), rank(1, 999))).toBe(true);
    expect(laterRank(rank(1, 5), rank(1, 4))).toBe(true);
    expect(laterRank(rank(1, 5, "b"), rank(1, 5, "a"))).toBe(true);
    expect(laterRank(rank(1, 5, "a"), rank(1, 5, "a"))).toBe(false);
  });

  test("any stamped write is later than a copy no stamped write reached", () => {
    expect(laterRank(rank(1), null)).toBe(true);
    expect(laterRank(null, rank(1))).toBe(false);
    expect(laterRank(null, null)).toBe(false);
  });

  test("a stamped copy ranks as its stamp; an unstamped one has no rank", () => {
    expect(orderRank(stampOrder({ machine_order: ["a", "b"] }, rank(3, 7, "d2")))).toEqual(rank(3, 7, "d2"));
    expect(orderRank({ machine_order: ["a", "b"] })).toBeNull();
    expect(orderRank(null)).toBeNull();
  });

  test("a copy moved by a client that keeps the stamp it found ranks above that write and below any later one", () => {
    const written = stampOrder({ machine_order: ["a", "b"] }, rank(3, 7, "d2"));
    const movedByOldClient = { ...written, machine_order: ["b", "a"] };
    const moved = orderRank(movedByOldClient);
    expect(laterRank(moved, rank(3, 7, "d2"))).toBe(true);
    expect(laterRank(rank(4, 1, "d1"), moved)).toBe(true);
  });

  test("the orders kept per core before the order was shared become one: the first copy's, then what the others add", () => {
    expect(mergedOrders([{ machine_order: ["b", "a"] }, { machine_order: ["a", "c", "b"] }, null])).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(mergedOrders([null, {}])).toBeNull();
  });

  test("two copies an older client moved on top of the same write rank by their order, the same on every device (#2534 review)", () => {
    const base = stampOrder({ machine_order: ["a", "b", "c"] }, rank(3, 7, "d2"));
    const one = orderRank({ ...base, machine_order: ["c", "a", "b"] });
    const two = orderRank({ ...base, machine_order: ["b", "c", "a"] });
    expect(laterRank(one, two)).toBe(!laterRank(two, one));
    expect(laterRank(one, two) || laterRank(two, one)).toBe(true);
  });
});
