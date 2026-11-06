import { expect, test } from "bun:test";
import { compareHcVersions, HC_VERSION_FLOOR, meetsHcFloor } from "./hc-version.ts";

test("the floor is the herdr-core Doriterm is built and tested against", () => {
  expect(HC_VERSION_FLOOR).toBe("0.1.17");
});

test.each([
  ["0.1.16", false],
  ["0.1.17", true],
  ["0.1.18", true],
  ["hc 0.1.17", true],
  ["0.2.0", true],
  ["0.1.17-rc.1", true],
] as const)("%p meets the floor: %p", (version, meets) => {
  expect(meetsHcFloor(version)).toBe(meets);
  expect(compareHcVersions(version, version)).toBe(0);
});
