import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingRow } from "./setting-row.tsx";

const slots = (control: ReactNode): number =>
  (renderToStaticMarkup(<SettingRow title="Row" control={control} />).match(/<div/g) ?? []).length;

test("a row whose control renders nothing has no control slot, whatever empty value it was given (#2520 review)", () => {
  const withControl = slots(<button type="button">Do</button>);
  for (const empty of [null, undefined, false, ""] as const) expect(slots(empty)).toBe(withControl - 1);
});
