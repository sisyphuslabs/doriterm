import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PINNED_CSS } from "./pinned-fonts.ts";

const declared = (css: string, token: string): string[] =>
  (new RegExp(`${token}:\\s*([^;]+);`, "s").exec(css)?.[1] ?? "")
    .split(",")
    .map((family) => family.trim())
    .filter((family) => family !== "");

test("the pinned terminal stack is the shipped --font-term with only the pinned Hangul face added (#2034)", () => {
  const shipped = declared(
    readFileSync(new URL("../../../packages/ui/src/styles/tokens.css", import.meta.url), "utf8"),
    "--font-term",
  );
  const pinned = declared(PINNED_CSS, "--font-term");
  expect(shipped.length).toBeGreaterThan(0);
  expect(pinned.filter((family) => family !== '"E2E Pinned Hangul"')).toEqual(shipped);
  // After the faces the app bundles (Powerline among them, #1403), before the platform's mono and Hangul names. The last
  // bundled face is read from terminal-fonts.css, so a face added there later moves the expectation with it.
  const bundled = new Set(
    [
      ...readFileSync(new URL("../../../packages/ui/src/styles/terminal-fonts.css", import.meta.url), "utf8").matchAll(
        /font-family:\s*"([^"]+)"/g,
      ),
    ].map((match) => `"${match[1]}"`),
  );
  const lastBundled = pinned.findLastIndex((family) => bundled.has(family));
  expect(lastBundled).toBeGreaterThanOrEqual(0);
  expect(pinned.indexOf('"E2E Pinned Hangul"')).toBe(lastBundled + 1);
  expect(pinned.indexOf('"Doriterm Powerline"')).toBeLessThan(pinned.indexOf('"E2E Pinned Hangul"'));
  expect(pinned.indexOf('"E2E Pinned Hangul"')).toBeLessThan(pinned.indexOf("ui-monospace"));
});
