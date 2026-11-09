import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SOURCES = ["apps/web/src", "packages/ui/src"];
const SIZE_UTILITY = /\b(?:size|w|h)-\d/;

const sourceFiles = (): { path: string; text: string }[] => {
  const files: { path: string; text: string }[] = [];
  for (const dir of SOURCES) {
    for (const entry of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(ROOT, dir) })) {
      if (entry.includes(".test.")) continue;
      files.push({ path: `${dir}/${entry}`, text: readFileSync(join(ROOT, dir, entry), "utf8") });
    }
  }
  return files;
};

describe("the spinner has one size", () => {
  test("the component defaults to the one size and marks itself so a container can leave it alone", () => {
    const spinner = readFileSync(join(ROOT, "packages/ui/src/components/spinner.tsx"), "utf8");
    expect(spinner).toContain('data-slot="spinner"');
    expect(spinner).toContain('"size-3 shrink-0 animate-spin-status"');
  });

  test("no call site passes a size utility to a spinner", () => {
    const offenders = sourceFiles().flatMap(({ path, text }) => {
      const hits: string[] = [];
      for (const match of text.matchAll(/<(?:Delayed)?Spinner\b[^>]*>/g)) {
        if (SIZE_UTILITY.test(match[0])) hits.push(`${path}: ${match[0]}`);
      }
      return hits;
    });
    expect(offenders).toEqual([]);
  });

  test("a container that sizes its icons leaves the spinner at the one size", () => {
    // The slot's descendant selector outranks the spinner's own size class, so the exclusion has to be in the
    // selector itself, on every utility it applies, not just the size.
    const emptyState = readFileSync(join(ROOT, "packages/ui/src/components/empty-state.tsx"), "utf8");
    const slot = emptyState.split("\n").find((line) => line.includes("[&_svg"));
    expect(slot).toBeDefined();
    const markers = (slot ?? "").split("[&_svg").slice(1);
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) expect(marker.startsWith(":not([data-slot=spinner])")).toBe(true);
  });
});
