import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SOURCES = ["apps/web/src", "packages/ui/src"];
const SIZE_UTILITY = /\b(?:size|w|h)-\d/;
const box = (classes: string | undefined): string | undefined => classes?.match(/\bsize-\S+/)?.[0];

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

  test("no container rule resizes a descendant svg without excluding the spinner", () => {
    // A container's descendant selector outranks the spinner's own size class, so the exclusion has to be in the
    // selector itself, wherever a container sizes its icons - not only in EmptyState.
    const offenders = sourceFiles().flatMap(({ path, text }) => {
      const hits: string[] = [];
      for (const match of text.matchAll(/\[&_svg(:[^\]]*)?\]:size-[^\s"']+/g)) {
        if (!match[0].includes(":not([data-slot=spinner])")) hits.push(`${path}: ${match[0]}`);
      }
      return hits;
    });
    expect(offenders).toEqual([]);
  });

  test("the voice strip gives the spinner the same box as the mic it replaces", () => {
    const strip = readFileSync(join(ROOT, "packages/ui/src/components/voice-strip.tsx"), "utf8");
    const mic = strip.match(/<span className="([^"]*)">\s*<Mic/);
    const spinner = strip.match(/<span className="([^"]*)">\s*<Spinner \/>/);
    expect(box(mic?.[1])).toBeDefined();
    expect(box(spinner?.[1])).toBe(box(mic?.[1]));
  });
});
