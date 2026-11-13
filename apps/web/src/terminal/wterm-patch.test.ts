import { expect, test } from "bun:test";
import { WTerm } from "@wterm/dom";

// The app draws a pane in the frame it is shown through renderNow (#2391), which @wterm/dom gets only from this repo's
// patch (patches/@wterm%2Fdom@0.5.9.patch). A wterm upgrade that drops the patch fails here, not as stale first frames.
test("the patched @wterm/dom has renderNow (#2391)", () => {
  expect(typeof Reflect.get(WTerm.prototype, "renderNow")).toBe("function");
});
