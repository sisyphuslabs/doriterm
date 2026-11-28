import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { ARCHIVE, buildSkillSite, withoutFrontmatter, writeSkillSite } from "./skill-site.ts";

const SOURCE = join(import.meta.dir, "..", "..", "..", "skills", "doriterm");
const TEMPLATE = readFileSync(join(import.meta.dir, "..", "docs", "index.html"), "utf8");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function repoFiles(dir: string, into: Record<string, Uint8Array> = {}): Record<string, Uint8Array> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) repoFiles(path, into);
    else into[relative(SOURCE, path).split(sep).join("/")] = readFileSync(path);
  }
  return into;
}

test("every served file is byte for byte the repo's skills/doriterm file, and nothing else is served as the skill", async () => {
  const landing = mkdtempSync(join(tmpdir(), "landing-skill-"));
  writeSkillSite(landing, await buildSkillSite(SOURCE), TEMPLATE);
  const repo = repoFiles(SOURCE);
  for (const [path, bytes] of Object.entries(repo)) {
    expect([path, sha256(readFileSync(join(landing, "public", "skill", path)))]).toEqual([path, sha256(bytes)]);
  }
  const served = readdirSync(join(landing, "public", "skill"), { recursive: true })
    .map(String)
    .filter((path) => statSync(join(landing, "public", "skill", path)).isFile());
  expect(served.toSorted()).toEqual([...Object.keys(repo), ARCHIVE, "SHA256SUMS"].toSorted());
});

test("the archive holds the same bytes, and SHA256SUMS names the archive and every file correctly", async () => {
  const site = await buildSkillSite(SOURCE);
  const unpacked = await new Bun.Archive(site.archive).files();
  const repo = repoFiles(SOURCE);
  expect([...unpacked.keys()].toSorted()).toEqual(
    Object.keys(repo)
      .map((path) => `doriterm/${path}`)
      .toSorted(),
  );
  const entries = [...unpacked];
  const unpackedBytes = await Promise.all(entries.map(([, file]) => file.bytes()));
  entries.forEach(([path], index) => {
    expect(sha256(unpackedBytes[index] ?? new Uint8Array())).toBe(
      sha256(repo[path.slice("doriterm/".length)] ?? new Uint8Array()),
    );
  });
  const lines = site.sums.trim().split("\n");
  expect(lines).toContain(`${sha256(site.archive)}  ${ARCHIVE}`);
  for (const [path, bytes] of Object.entries(repo)) expect(lines).toContain(`${sha256(bytes)}  ${path}`);
});

test("the page renders SKILL.md and each reference inside the docs chrome, with raw links and the download", async () => {
  const landing = mkdtempSync(join(tmpdir(), "landing-skill-page-"));
  writeSkillSite(landing, await buildSkillSite(SOURCE), TEMPLATE);
  const page = readFileSync(join(landing, "skill", "index.html"), "utf8");
  expect(page).toContain("<title>The Doriterm skill · Doriterm docs</title>");
  expect(page).toContain('href="/skill/SKILL.md"');
  expect(page).toContain(`href="/skill/${ARCHIVE}"`);
  for (const path of Object.keys(repoFiles(SOURCE)).filter((name) => name.endsWith(".md"))) {
    expect(page).toContain(`href="/skill/${path}"`);
  }
  expect(page).toContain("<h1>Doriterm</h1>");
  for (const [open, close] of [
    ["<nav", "</nav>"],
    ['<footer class="footer">', "</footer>"],
  ] as const) {
    const block = (html: string): string =>
      html.slice(html.indexOf(open), html.indexOf(close, html.indexOf(open)) + close.length);
    expect(block(TEMPLATE).length).toBeGreaterThan(open.length);
    expect(block(page)).toBe(block(TEMPLATE));
  }
});

test("the page drops SKILL.md's YAML header, which is for agents; the raw file keeps it", async () => {
  expect(withoutFrontmatter("---\nname: x\n---\n# Title\n")).toBe("# Title\n");
  expect(withoutFrontmatter("# No header\n")).toBe("# No header\n");
  const landing = mkdtempSync(join(tmpdir(), "landing-skill-yaml-"));
  writeSkillSite(landing, await buildSkillSite(SOURCE), TEMPLATE);
  expect(readFileSync(join(landing, "skill", "index.html"), "utf8")).not.toContain("name: doriterm");
  expect(readFileSync(join(landing, "public", "skill", "SKILL.md"), "utf8").startsWith("---\nname: doriterm")).toBe(
    true,
  );
});
