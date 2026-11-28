import { expect, test } from "bun:test";
import { BUNDLED_SKILL } from "./bundled.ts";

test("every background run the bundled skill teaches outlives the agent that starts it (#2990)", () => {
  const runs = BUNDLED_SKILL.files.flatMap((file) =>
    file.text
      .split("\n")
      .filter((line) => line.startsWith("hc run --bg"))
      .map((line) => `${file.path}: ${line}`),
  );
  expect(runs.length).toBeGreaterThan(0);
  expect(runs.filter((line) => !/ --outlive-parent\b/.test(line))).toEqual([]);
});
