#!/usr/bin/env bun
/**
 * Publishes the Doriterm agent skill on doriterm.com from `skills/doriterm`, at build time, so the site never holds a
 * copy that can drift. It writes the raw files to public/skill/ (served as /skill/<path>), one archive with
 * SHA256SUMS next to it, and skill/index.html, the page that renders them, which vite builds like a docs page.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const ARCHIVE = "doriterm-skill.tar.gz";

export interface SkillSite {
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  readonly archive: Uint8Array;
  readonly sums: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function walk(root: string, dir: string, into: { path: string; bytes: Uint8Array }[]): void {
  for (const name of readdirSync(dir).toSorted()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(root, path, into);
    else into.push({ path: relative(root, path).split(sep).join("/"), bytes: readFileSync(path) });
  }
}

/** Reads the skill and builds what the site serves: the files as they are, the archive, and their checksums. */
export async function buildSkillSite(source: string): Promise<SkillSite> {
  const files: { path: string; bytes: Uint8Array }[] = [];
  walk(source, source, files);
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error(`${source} has no SKILL.md`);
  const archive = await new Bun.Archive(
    Object.fromEntries(files.map((file) => [`doriterm/${file.path}`, file.bytes])),
    { compress: "gzip" },
  ).bytes();
  const sums = [...files.map((file) => `${sha256(file.bytes)}  ${file.path}`), `${sha256(archive)}  ${ARCHIVE}`].join(
    "\n",
  );
  return { files, archive, sums: `${sums}\n` };
}

/** A skill file's YAML header is for agents that load it; the page shows the text a person reads. */
export const withoutFrontmatter = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n/, "");

const escape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The page: the docs page's own chrome around SKILL.md and each reference, rendered, with the raw links and the download. */
export function skillPage(template: string, site: SkillSite): string {
  const open = '<article class="docs__article">';
  const start = template.indexOf(open);
  const end = template.indexOf("</article>", start);
  if (start < 0 || end < 0) throw new Error("the docs template has no docs__article");
  const archiveSum =
    site.sums
      .split("\n")
      .find((line) => line.endsWith(`  ${ARCHIVE}`))
      ?.split(" ")[0] ?? "";
  const sections = site.files
    .filter((file) => file.path.endsWith(".md"))
    .map((file) => {
      const html = Bun.markdown.html(withoutFrontmatter(new TextDecoder().decode(file.bytes)));
      const raw = `/skill/${file.path}`;
      return `<section class="docs__skill-file"><p class="eyebrow"><a href="${raw}">${escape(file.path)}</a></p>${html}</section>`;
    })
    .join("\n");
  const article = `${open}
          <header class="docs__head"><p class="eyebrow"><a href="/docs/">Docs</a><span class="rule"></span>Skill</p></header>
          <h1 class="docs__title">The Doriterm skill <span class="soft">for your agents</span></h1>
          <p class="docs__lede">
            Give an agent this skill and it can run, read, message and wait on terminals, files and machines through
            Doriterm, with the <code>hc</code> CLI. Install it with <code>doriface-host skill install</code>, or download it here.
          </p>
          <p><a href="/skill/${ARCHIVE}" download>Download ${ARCHIVE}</a></p>
          <p>SHA-256 <code>${archiveSum}</code>. Every file's checksum is in <a href="/skill/SHA256SUMS">SHA256SUMS</a>.</p>
          ${sections}
        `;
  return (template.slice(0, start) + article + template.slice(end))
    .replace(/<title>[^<]*<\/title>/, "<title>The Doriterm skill · Doriterm docs</title>")
    .replaceAll('https://doriterm.com/docs/"', 'https://doriterm.com/skill/"');
}

/** Writes the site into the landing app: public/skill/ for the raw files, skill/index.html for vite. */
export function writeSkillSite(landing: string, site: SkillSite, template: string): void {
  const out = join(landing, "public", "skill");
  rmSync(out, { recursive: true, force: true });
  for (const file of site.files) {
    mkdirSync(dirname(join(out, file.path)), { recursive: true });
    writeFileSync(join(out, file.path), file.bytes);
  }
  writeFileSync(join(out, ARCHIVE), site.archive);
  writeFileSync(join(out, "SHA256SUMS"), site.sums);
  mkdirSync(join(landing, "skill"), { recursive: true });
  writeFileSync(join(landing, "skill", "index.html"), skillPage(template, site));
}

if (import.meta.main) {
  const landing = join(import.meta.dir, "..");
  const site = await buildSkillSite(join(landing, "..", "..", "skills", "doriterm"));
  writeSkillSite(landing, site, readFileSync(join(landing, "docs", "index.html"), "utf8"));
  console.log(`skill site: ${site.files.length} files, ${ARCHIVE} ${site.archive.length} bytes`);
}
