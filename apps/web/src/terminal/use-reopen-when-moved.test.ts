import { describe, expect, test } from "bun:test";
import { reopensAt } from "./use-reopen-when-moved.ts";

const OLD = "studio/t1";
const NEW = "studio-2/t1";
const REFUSED = "hc refused the attach";

describe("a view refused at a renamed machine's old name opens again only at the new one (#656, #1017)", () => {
  test("never at the address the attach was refused at", () => {
    expect(reopensAt(OLD, REFUSED, OLD)).toBe(false);
  });

  test("once the address moved to the new name", () => {
    expect(reopensAt(NEW, REFUSED, OLD)).toBe(true);
  });

  test("a second refusal at the new address does not reopen again, so it cannot loop against hc", () => {
    const refusals = [OLD];
    let reopened = 0;
    for (const address of [OLD, NEW, NEW]) {
      if (reopensAt(address, REFUSED, refusals.at(-1) ?? null)) {
        reopened += 1;
        refusals.push(address);
      }
    }
    expect(reopened).toBe(1);
  });

  test("a view that is open is left alone", () => {
    expect(reopensAt(NEW, null, OLD)).toBe(false);
  });
});
