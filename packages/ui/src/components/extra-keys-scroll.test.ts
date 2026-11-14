import { expect, test } from "bun:test";
import { peekWidth } from "./extra-keys-scroll.ts";

const row = (count: number) => Array.from({ length: count }, (_, at) => ({ left: at * 44, width: 44 }));

test("a row whose last key would end flush with its room cuts that key, so a part of it shows (#2604)", () => {
  // Three keys fill 132 of 139 px: the third ends inside the last 16 px, so it is cut to 40% of its width.
  expect(peekWidth(139, row(8))).toBe(88 + 18);
});

test("a row with room to spare shows its next key's cut as it falls", () => {
  expect(peekWidth(110, row(8))).toBe(110);
});

test("a row whose keys all fit takes the room as it is", () => {
  expect(peekWidth(200, row(3))).toBe(200);
});
