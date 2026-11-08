#!/usr/bin/env bun
/**
 * Writes the release notes for a version to stdout: the CHANGELOG.md section for that version, then the downloads in
 * the assets directory and which builds are code signed. A release with no section, or a section with no lines, is
 * refused (exit 1), so a tag cannot publish without notes. A prerelease (1.2.0-rc.1) takes the 1.2.0 section, or the
 * Unreleased section and the changes/unreleased/ fragments while 1.2.0 has none (changelog-fragments.ts).
 *
 * Usage: bun .github/scripts/release-notes.ts <version> <assets dir>
 *        bun .github/scripts/release-notes.ts --check <version>   (only the refusal, before any build)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAGMENT_DIR, pendingNotes, readFragments } from "./changelog-fragments.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

interface Download {
  readonly label: string;
  readonly matches: (name: string) => boolean;
}

const has = (name: string, ...parts: readonly string[]): boolean => parts.every((part) => name.includes(part));
const isArm = (name: string): boolean => name.includes("arm64") || name.includes("aarch64");

const DOWNLOADS: readonly Download[] = [
  {
    label: "macOS, Apple silicon",
    matches: (name) => isArm(name) && (name.endsWith(".dmg") || name.endsWith("-mac.zip")),
  },
  { label: "macOS, Intel", matches: (name) => !isArm(name) && (name.endsWith(".dmg") || name.endsWith("-mac.zip")) },
  { label: "Windows x64", matches: (name) => !isArm(name) && name.endsWith(".exe") },
  { label: "Windows arm64", matches: (name) => isArm(name) && name.endsWith(".exe") },
  { label: "Linux x64", matches: (name) => !isArm(name) && (name.endsWith(".AppImage") || name.endsWith(".deb")) },
  { label: "Linux arm64", matches: (name) => isArm(name) && (name.endsWith(".AppImage") || name.endsWith(".deb")) },
  { label: "Web client and PWA (static files)", matches: (name) => has(name, "-web-") && name.endsWith(".zip") },
  { label: "Render bench against the last release (#670)", matches: (name) => has(name, "-render-bench.") },
  {
    label: "Host only, Linux and macOS (`curl -fsSL <this release>/install.sh | sh` installs it as a user service)",
    matches: (name) => name === "install.sh" || name.startsWith("doriface-host-"),
  },
];

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The lines under a `## <name>`, `## v<name>` or `## [<name>]` heading (anything after it, such as a date, is allowed),
 * up to the next `## ` heading; undefined when there is no such heading.
 */
function changelogSection(lines: readonly string[], name: string): string | undefined {
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(name)}\\]?(?:\\s|$)`, "i");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** A section says something only when it has a line that is neither blank nor a `###` subheading. */
const hasEntries = (section: string): boolean =>
  section.split("\n").some((line) => line.trim() !== "" && !/^#{3,}\s/.test(line));

/** The section that holds this release's notes, or why there is none. */
function releaseSection(version: string): { notes: string } | { refusal: string } {
  if (!existsSync(CHANGELOG)) return { refusal: "CHANGELOG.md is missing" };
  const text = readFileSync(CHANGELOG, "utf8");
  const lines = text.split(/\r?\n/);
  const fragments = readFragments(join(ROOT, FRAGMENT_DIR));
  const base = version.split("-")[0] ?? version;
  const pending = pendingNotes(text, fragments);
  if (!pending.ok) return { refusal: pending.problems.join("; ") };
  const names = version === base ? [version] : [version, base, "Unreleased"];
  const found = names.flatMap((name) => {
    const section = name === "Unreleased" ? pending.notes : changelogSection(lines, name);
    return section === undefined ? [] : [{ name, section }];
  });
  const first = found.find(({ section }) => hasEntries(section));
  if (first !== undefined) return { notes: first.section };
  const wanted = names.map((name) => (name === "Unreleased" ? "## Unreleased" : `## v${name}`)).join(" or ");
  return found.length === 0
    ? { refusal: `CHANGELOG.md has no ${wanted} section for v${version}` }
    : { refusal: `CHANGELOG.md's ${wanted} section for v${version} is empty: it has no lines for users` };
}

function refuse(refusal: string): never {
  console.error(
    `::error title=Release notes::${refusal}. Add the section with what changed for users before tagging (CONTRIBUTING.md, "Changelog").`,
  );
  process.exit(1);
}

function downloads(assets: readonly string[]): string {
  const rows = DOWNLOADS.flatMap((download) => {
    const names = assets.filter(download.matches);
    return names.length === 0 ? [] : [`- **${download.label}:** ${names.map((name) => `\`${name}\``).join(", ")}`];
  });
  return [...rows, "- `SHA256SUMS.txt` lists the SHA-256 of every file (`sha256sum --check SHA256SUMS.txt`)."].join(
    "\n",
  );
}

const SIGNING = `## Code signing

- **macOS:** signed with a Developer ID certificate and notarized by Apple, and the dmg is stapled, so it opens without a Gatekeeper warning.
- **Windows:** not code signed yet, so SmartScreen warns about an unknown publisher. Choose **More info**, then **Run anyway**.
- **Linux:** make the AppImage executable (\`chmod +x\`) and run it, or install the deb with \`sudo apt install ./<file>.deb\`.`;

const USAGE =
  "usage: bun .github/scripts/release-notes.ts <version> <assets dir>\n" +
  "       bun .github/scripts/release-notes.ts --check <version>";
const args = Bun.argv.slice(2);
const checkOnly = args[0] === "--check";
const [rawVersion, assetsDir] = checkOnly ? [args[1], undefined] : args;
if (rawVersion === undefined || (!checkOnly && assetsDir === undefined)) {
  console.error(USAGE);
  process.exit(2);
}
const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;

const resolved = releaseSection(version);
if ("refusal" in resolved) refuse(resolved.refusal);
if (checkOnly || assetsDir === undefined) process.exit(0);

const assets = readdirSync(assetsDir)
  .filter((name) => name !== "SHA256SUMS.txt")
  .toSorted();
const changes = resolved.notes;
console.log([`# Doriterm v${version}`, changes, `## Downloads\n\n${downloads(assets)}`, SIGNING].join("\n\n"));
