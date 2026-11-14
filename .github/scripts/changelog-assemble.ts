#!/usr/bin/env bun
/**
 * Run in a release pull request: writes the `## Unreleased` lines and every changes/unreleased/ fragment into the new
 * `## vX.Y.Z - YYYY-MM-DD` section of CHANGELOG.md, leaves `## Unreleased` empty above it, and deletes the fragments
 * (changelog-fragments.ts). Running it again changes nothing. A fragment the release cannot place is refused, and then
 * nothing is written or deleted.
 *
 * Usage: bun .github/scripts/changelog-assemble.ts [<version>] [--date YYYY-MM-DD]
 * The version defaults to apps/desktop/package.json's, the date to today (UTC).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleRelease, FRAGMENT_DIR, readFragments } from "./changelog-fragments.ts";

const ROOT = join(import.meta.dir, "..", "..");
const USAGE = "usage: bun .github/scripts/changelog-assemble.ts [<version>] [--date YYYY-MM-DD]";

function fail(message: string): never {
  console.error(`::error title=Changelog assembly::${message}`);
  process.exit(1);
}

function desktopVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "apps", "desktop", "package.json"), "utf8"));
  const version: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : undefined;
  if (typeof version !== "string") fail("apps/desktop/package.json has no version");
  return version;
}

const args = Bun.argv.slice(2);
const dateAt = args.indexOf("--date");
const date = dateAt === -1 ? new Date().toISOString().slice(0, 10) : args[dateAt + 1];
const positional = dateAt === -1 ? args : args.filter((_, index) => index !== dateAt && index !== dateAt + 1);
if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date) || positional.length > 1) {
  console.error(USAGE);
  process.exit(2);
}
const requested = positional[0] ?? desktopVersion();
const version = requested.startsWith("v") ? requested.slice(1) : requested;

const changelogPath = join(ROOT, "CHANGELOG.md");
const fragmentDir = join(ROOT, FRAGMENT_DIR);
const fragments = readFragments(fragmentDir);
const result = assembleRelease({ changelog: readFileSync(changelogPath, "utf8"), fragments, version, date });
if (!result.ok) fail(result.problems.join("\n"));

if (result.changed) writeFileSync(changelogPath, result.changelog);
for (const { name } of fragments) rmSync(join(fragmentDir, name));
console.log(
  result.changed
    ? `CHANGELOG.md: v${version} gained ${result.lines} line(s); deleted ${fragments.length} fragment(s) from ${FRAGMENT_DIR}.`
    : `CHANGELOG.md: v${version} already holds every line; nothing to write.`,
);
