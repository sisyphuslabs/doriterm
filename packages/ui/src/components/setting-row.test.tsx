import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingRow } from "./setting-row.tsx";

const slots = (control: ReactNode): number =>
  (renderToStaticMarkup(<SettingRow title="Row" control={control} />).match(/<div/g) ?? []).length;

const EMPTY: readonly (readonly [string, ReactNode])[] = [
  ["null", null],
  ["undefined", undefined],
  ["false", false],
  ["true", true],
  ['""', ""],
  ["[]", []],
  ['[false, null, ""]', [false, null, ""]],
];

// One case per value, so a failure names the value that still gets a slot (#2520, #2571 reviews).
test.each(EMPTY)("a row whose control is %s has no control slot", (_name, empty) => {
  expect(slots(empty)).toBe(slots(<button type="button">Do</button>) - 1);
});
