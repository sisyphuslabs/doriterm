/**
 * Changelog fragments: a pull request writes its changelog lines into a file of its own, `changes/unreleased/<pr
 * number>.md` (or `<lowercase-branch-slug>.md` before the number exists), instead of under `## Unreleased` in
 * CHANGELOG.md, so open pull requests stop conflicting on the same lines each time one merges (#1254). A fragment is
 * one or more `### <Section>` headings, each followed by its `- ` lines; a long line may go on over lines indented two
 * spaces. changes/README.md documents the format.
 *
 * The release pull request runs changelog-assemble.ts, which writes the Unreleased lines and every fragment into the
 * new `## vX.Y.Z - YYYY-MM-DD` section and deletes the fragments. changelog-check.ts and release-notes.ts read the
 * fragments through this module too, so all three agree on what a fragment is.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the fragments live, relative to the repository root. */
export const FRAGMENT_DIR = "changes/unreleased";

/**
 * The section headings a release is written under, in the order they appear in it. A heading that names one of these,
 * in any case or by one of its aliases, is written with this spelling; any other heading is kept as written and goes
 * after these, in the order CHANGELOG.md first uses it, then in the order the fragments do. An alias names one section
 * and nothing broader: a bare `Host` is not an alias of Host install, since a line about the host at run time (its
 * version, /healthz) is not about installing it (#1326), so a `### Host` heading is kept as written.
 */
export const CANONICAL_HEADINGS: readonly { readonly heading: string; readonly aliases?: readonly string[] }[] = [
  { heading: "Terminal", aliases: ["Terminals", "The terminal"] },
  { heading: "Fonts, Korean text and the terminal" },
  { heading: "Workspace", aliases: ["First run"] },
  { heading: "Keys", aliases: ["Keys, as herdr-app binds them"] },
  { heading: "Machine mesh", aliases: ["Mesh", "The mesh", "Machines"] },
  { heading: "Joining a mesh", aliases: ["Adding a machine"] },
  { heading: "Pairing from a phone" },
  { heading: "Phone", aliases: ["The phone", "From the phone"] },
  { heading: "Web app", aliases: ["The web app"] },
  { heading: "Desktop window" },
  { heading: "Desktop updates" },
  { heading: "Settings" },
  { heading: "Notifications" },
  { heading: "Connection and offline wording", aliases: ["Connection"] },
  { heading: "Host install", aliases: ["The host installer", "Host setup"] },
  { heading: "Native apps" },
  { heading: "Windows" },
  { heading: "Linux" },
  { heading: "Website" },
  { heading: "Documentation" },
  { heading: "Reliability" },
];

export interface Fragment {
  /** The file name inside changes/unreleased/, such as `1254.md`. */
  readonly name: string;
  readonly text: string;
}

/** Lines grouped by section heading; `loose` holds lines that sit under no `###` heading. */
interface Notes {
  readonly loose: string[];
  readonly groups: { heading: string; entries: string[] }[];
}

export type Refusal = { readonly ok: false; readonly problems: readonly string[] };

const FRAGMENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const SECTION_HEADING = /^##\s/;
const SUBHEADING = /^###\s+(\S.*?)\s*$/;
const UNRELEASED = /^##\s+\[?Unreleased\]?(?:\s|$)/i;
const RELEASE_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)/;
const VERSION = /^\d+\.\d+\.\d+$/;

const key = (heading: string): string => heading.trim().replaceAll(/\s+/g, " ").toLowerCase();

const CANONICAL = new Map(
  CANONICAL_HEADINGS.flatMap(({ heading, aliases = [] }) =>
    [heading, ...aliases].map((name): [string, string] => [key(name), heading]),
  ),
);

/** The heading a section is written under: the canonical spelling when it names a canonical heading or an alias. */
export const canonicalHeading = (heading: string): string =>
  CANONICAL.get(key(heading)) ?? heading.trim().replaceAll(/\s+/g, " ");

/** The fragments in a directory, sorted as the release writes them: numbers in order, then slugs. */
export function readFragments(dir: string): Fragment[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, text: readFileSync(join(dir, entry.name), "utf8") }))
    .toSorted((a, b) => compareNames(a.name, b.name));
}

function compareNames(a: string, b: string): number {
  const [na, nb] = [/^\d+(?=\.md$)/.exec(a)?.[0], /^\d+(?=\.md$)/.exec(b)?.[0]];
  if (na !== undefined && nb !== undefined) return Number(na) - Number(nb);
  if (na !== undefined) return -1;
  if (nb !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A fragment's lines by heading, or every reason it cannot be placed in a release. */
export function parseFragment(fragment: Fragment): { readonly ok: true; readonly notes: Notes } | Refusal {
  const path = `${FRAGMENT_DIR}/${fragment.name}`;
  if (!FRAGMENT_NAME.test(fragment.name)) {
    return {
      ok: false,
      problems: [`${path}: a fragment is named <pr-number>.md, or <lowercase-branch-slug>.md before the number exists`],
    };
  }
  const lines = fragment.text.split(/\r?\n/);
  if (lines.every((line) => line.trim() === "")) return { ok: false, problems: [`${path} is empty`] };
  const problems: string[] = [];
  const notes: Notes = { loose: [], groups: [] };
  let group: Notes["groups"][number] | undefined;
  let entry = false;
  lines.forEach((line, index) => {
    const where = `${path} line ${index + 1}`;
    const heading = SUBHEADING.exec(line);
    if (line.trim() === "") return;
    if (heading?.[1] !== undefined) {
      group = { heading: heading[1], entries: [] };
      notes.groups.push(group);
      entry = false;
    } else if (/^###\s*$/.test(line)) {
      problems.push(`${where}: a \`###\` heading with no section name`);
    } else if (line.startsWith("#")) {
      problems.push(`${where}: only \`### <Section>\` headings go in a fragment, not \`${line.trim()}\``);
    } else if (line.startsWith("- ")) {
      if (group === undefined) problems.push(`${where}: a line before any ### heading; put it under its section`);
      else group.entries.push(line);
      entry = true;
    } else if (/^\s{2,}\S/.test(line) && entry && group !== undefined) {
      const last = group.entries.length - 1;
      group.entries[last] = `${group.entries[last] ?? ""}\n${line}`;
    } else {
      problems.push(`${where}: not a \`- \` line, a \`### \` heading, or a continuation indented two spaces`);
    }
  });
  for (const { heading, entries } of notes.groups) {
    if (entries.length === 0) problems.push(`${path}: ### ${heading} has no lines`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, notes };
}

/**
 * The lines of a CHANGELOG.md section by heading, read as leniently as the file was written: a `- ` line starts an
 * entry, a line right under it or indented continues it, and any other text is an entry of its own.
 */
function parseSection(body: readonly string[]): Notes {
  const notes: Notes = { loose: [], groups: [] };
  let entries = notes.loose;
  let open = false;
  let blank = false;
  for (const line of body) {
    const heading = SUBHEADING.exec(line);
    if (heading?.[1] !== undefined) {
      const group = { heading: heading[1], entries: [] };
      notes.groups.push(group);
      entries = group.entries;
      open = false;
    } else if (line.trim() === "") {
      blank = open;
    } else if (open && !line.startsWith("- ") && (!blank || /^\s/.test(line))) {
      entries[entries.length - 1] = `${entries.at(-1) ?? ""}${blank ? "\n" : ""}\n${line}`;
      blank = false;
    } else {
      entries.push(line);
      open = true;
      blank = false;
    }
  }
  return notes;
}

const lineCount = (notes: Notes): number =>
  notes.loose.length + notes.groups.reduce((sum, group) => sum + group.entries.length, 0);

function addOnce(into: string[], entry: string): void {
  if (!into.some((known) => known.trim() === entry.trim())) into.push(entry);
}

/** Every source's lines under one heading each, canonical headings first in their order, duplicates dropped. */
function mergeNotes(sources: readonly Notes[], changelogHeadings: readonly string[]): Notes {
  const rank = new Map<string, number>();
  for (const { heading } of CANONICAL_HEADINGS) rank.set(key(heading), rank.size);
  for (const heading of changelogHeadings) {
    const canonical = key(canonicalHeading(heading));
    if (!rank.has(canonical)) rank.set(canonical, rank.size);
  }
  const loose: string[] = [];
  const groups = new Map<string, { heading: string; entries: string[] }>();
  for (const source of sources) {
    for (const entry of source.loose) addOnce(loose, entry);
    for (const { heading, entries } of source.groups) {
      const name = canonicalHeading(heading);
      if (!rank.has(key(name))) rank.set(key(name), rank.size);
      const group = groups.get(key(name)) ?? { heading: name, entries: [] };
      groups.set(key(name), group);
      for (const entry of entries) addOnce(group.entries, entry);
    }
  }
  const ordered = [...groups.entries()]
    .filter(([, group]) => group.entries.length > 0)
    .toSorted(([a], [b]) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
    .map(([, group]) => group);
  return { loose, groups: ordered };
}

function renderNotes(notes: Notes): string {
  const blocks = [
    ...(notes.loose.length > 0 ? [notes.loose.join("\n")] : []),
    ...notes.groups.map(({ heading, entries }) => `### ${heading}\n\n${entries.join("\n")}`),
  ];
  return blocks.join("\n\n");
}

interface Changelog {
  readonly preamble: string[];
  readonly sections: { heading: string; body: string[] }[];
}

function splitChangelog(text: string): Changelog {
  const lines = text.split("\n");
  const preamble: string[] = [];
  const sections: Changelog["sections"] = [];
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) sections.push({ heading: line, body: [] });
    else (sections.at(-1)?.body ?? preamble).push(line);
  }
  return { preamble, sections };
}

const trimEnd = (lines: readonly string[]): string => lines.join("\n").replace(/\s+$/, "");

function parseFragments(fragments: readonly Fragment[]): { ok: true; notes: Notes[] } | Refusal {
  const parsed = fragments.map(parseFragment);
  const problems = parsed.flatMap((result) => (result.ok ? [] : result.problems));
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, notes: parsed.flatMap((result) => (result.ok ? [result.notes] : [])) };
}

const headingsOf = (changelog: string): string[] =>
  changelog.split("\n").flatMap((line) => SUBHEADING.exec(line)?.[1] ?? []);

/** What the next release would say: the Unreleased lines and every fragment, as a prerelease's notes. */
export function pendingNotes(
  changelog: string,
  fragments: readonly Fragment[],
): { readonly ok: true; readonly notes: string } | Refusal {
  const parsed = parseFragments(fragments);
  if (!parsed.ok) return parsed;
  const unreleased = splitChangelog(changelog).sections.find((section) => UNRELEASED.test(section.heading));
  const sources = [parseSection(unreleased?.body ?? []), ...parsed.notes];
  return { ok: true, notes: renderNotes(mergeNotes(sources, headingsOf(changelog))) };
}

export interface Assembly {
  readonly ok: true;
  /** CHANGELOG.md with the release section written and `## Unreleased` left empty above it. */
  readonly changelog: string;
  readonly changed: boolean;
  /** How many lines the section gained. */
  readonly lines: number;
}

/**
 * Writes the `## vX.Y.Z - <date>` section from the Unreleased lines and the fragments, leaving `## Unreleased` empty
 * above it; the caller deletes the fragments. A section that already exists keeps its heading and gains the new lines,
 * where it stands, even below a newer one, so running it again once the fragments are gone changes nothing. Every
 * other section stays as written.
 */
export function assembleRelease(input: {
  readonly changelog: string;
  readonly fragments: readonly Fragment[];
  readonly version: string;
  readonly date: string;
}): Assembly | Refusal {
  const { changelog, fragments, version, date } = input;
  if (!VERSION.test(version)) {
    return { ok: false, problems: [`"${version}" is not a release version: a section is written for X.Y.Z only`] };
  }
  const parsed = parseFragments(fragments);
  if (!parsed.ok) return parsed;
  const { preamble, sections } = splitChangelog(changelog);
  const unreleased = sections.find((section) => UNRELEASED.test(section.heading));
  const existing = sections.find((section) => RELEASE_HEADING.exec(section.heading)?.[1] === version);
  const incoming = [parseSection(unreleased?.body ?? []), ...parsed.notes];
  const lines = incoming.reduce((sum, notes) => sum + lineCount(notes), 0);
  if (lines === 0) {
    if (existing !== undefined) return { ok: true, changelog, changed: false, lines: 0 };
    return { ok: false, problems: [`nothing to release as v${version}: Unreleased and ${FRAGMENT_DIR} hold no lines`] };
  }
  const before = parseSection(existing?.body ?? []);
  const merged = mergeNotes([before, ...incoming], headingsOf(changelog));
  const release = { heading: existing?.heading ?? `## v${version} - ${date}`, body: ["", renderNotes(merged)] };
  const emptied = { heading: unreleased?.heading ?? "## Unreleased", body: [] };
  const rest = sections
    .filter((section) => section !== unreleased)
    .map((section) => (section === existing ? release : section));
  const firstRelease = rest.findIndex((section) => RELEASE_HEADING.test(section.heading));
  const at = firstRelease === -1 ? rest.length : firstRelease;
  const ordered = [...rest.slice(0, at), emptied, ...(existing === undefined ? [release] : []), ...rest.slice(at)];
  const blocks = [trimEnd(preamble), ...ordered.map((section) => trimEnd([section.heading, ...section.body]))];
  const written = `${blocks.filter((block) => block !== "").join("\n\n")}\n`;
  const added = lineCount(merged) - lineCount(before);
  return { ok: true, changelog: written, changed: written !== changelog, lines: added };
}
