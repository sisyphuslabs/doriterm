import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_CREDITS } from "./library.ts";

const ROOT = join(import.meta.dirname, "../..");
const NOTICE = readFileSync(join(ROOT, "NOTICE"), "utf8");
const SEPARATOR = /\n-{20,}\n/;
/** Each NOTICE section, keyed by the project URL on its heading line. */
const sections = new Map(
  NOTICE.split(SEPARATOR)
    .slice(1)
    .map((section) => [/\((https:\/\/github\.com\/[^)]+)\)/.exec(section)?.[1] ?? "", section] as const),
);

test.each(Object.entries(LIBRARY_CREDITS))("%s carries its project's notice", (_, credit) => {
  const section = sections.get(credit.url);
  expect(section).toBeDefined();
  expect(section).toContain(credit.name);
  if (credit.licence === "MIT") {
    expect(section).toMatch(/^Copyright \([cC]\) .+$/m);
    expect(section).toContain("Permission is hereby granted, free of charge");
  } else {
    expect(section).toContain("Licensed under the Apache License, Version 2.0");
    expect(readFileSync(join(ROOT, "licenses/Apache-2.0.txt"), "utf8")).toContain("TERMS AND CONDITIONS FOR USE");
  }
});

test("the collection the palettes came through carries its own notice", () => {
  expect(sections.get("https://github.com/mbadolato/iTerm2-Color-Schemes")).toContain(
    "Copyright (c) 2011 to Present Mark Badolato",
  );
});
