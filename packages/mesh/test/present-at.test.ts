import { describe, expect, test } from "bun:test";
import { presentAtOfRecords } from "../src/pool.ts";
import { ack, admit, found, withChainNumbers } from "./fixtures/records.ts";

describe("design 6.1: the members a backdated record of X could eject", () => {
  test("X's last own record places it, not its admission", () => {
    const records = withChainNumbers([
      found("F", "F"),
      admit("a1", "F", "A", ["F"]),
      admit("b1", "F", "B", ["a1"]),
      ack("x1", "A", ["b1"]),
      admit("c1", "F", "C", ["x1"]),
    ]);
    expect(presentAtOfRecords(records, "A")).toEqual(["F", "B"]);
  });

  test("a key that never wrote is placed at its admission", () => {
    const records = withChainNumbers([found("F", "F"), admit("a1", "F", "A", ["F"]), admit("b1", "F", "B", ["a1"])]);
    expect(presentAtOfRecords(records, "A")).toEqual(["F"]);
  });
});
