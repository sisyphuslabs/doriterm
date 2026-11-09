import { $ } from "bun";
import { cpus } from "node:os";

/**
 * Screenshots in a public repository must not show an account name, a host name or an internal run path. Six did, and a
 * reviewer's eye missed five of them for weeks (#926), so the check is mechanical.
 *
 * The checks describe the SHAPE of a leak and never a value: a list of the real fleet names would put them back in the
 * repository that removed them, and a finding names the pattern, never the matched text, because the match is the leak.
 */
export const NEUTRAL_NAMES: ReadonlySet<string> = new Set([
  "demo",
  "user",
  "me",
  "you",
  "example",
  "project",
  "laptop",
  "box",
  "sandbox",
  "dev",
  "work",
  "localhost",
  "root",
]);

const isNeutral = (name: string): boolean => NEUTRAL_NAMES.has(name.toLowerCase().replace(/^my-/, ""));

/** Registry-style suffixes an `@` in prose takes; they name a package, not an account on a computer. */
const PACKAGE_SUFFIX = /^(?:latest|next|beta|alpha|canary|stable)$/i;
/** The domains reserved for examples (RFC 2606, RFC 6761), subdomains included: a placeholder uses them, a real capture never shows one. */
const RESERVED_EXAMPLE = /^(?:[a-z0-9-]+\.)*(?:example|example\.(?:com|org|net))$/i;
/** `git@<host>` where the host is a known git host: every one's SSH user is `git`, which names no one, and the `:owner/repo` tail is never checked. */
const CLONE_URL = /^git@(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i;

const ACCOUNT_AT_HOST = /\b([a-z][a-z0-9._-]*)@([a-z][a-z0-9.-]*[a-z0-9])/gi;
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z][A-Za-z0-9._-]*)/g;
const RUN_ROOT = /\/(?:srv|var\/tmp|private\/tmp|var\/folders|tmp)\/[A-Za-z]/;
const OPT_ROOT = /\/opt\/(?!homebrew\b)[A-Za-z]/;

export interface Verdict {
  readonly ok: boolean;
  readonly findings: readonly { readonly pattern: string }[];
}

/** Which shapes a piece of OCR text trips, by name only: the matched text is the leak and is never returned. */
export function classify(ocrText: string): Verdict {
  const findings: { pattern: string }[] = [];
  const add = (pattern: string): void => {
    if (!findings.some((one) => one.pattern === pattern)) findings.push({ pattern });
  };

  for (const match of ocrText.matchAll(ACCOUNT_AT_HOST)) {
    const account = match[1] ?? "";
    const host = match[2] ?? "";
    if (isNeutral(account) && isNeutral(host)) continue;
    if (PACKAGE_SUFFIX.test(host) || RESERVED_EXAMPLE.test(host) || CLONE_URL.test(`${account}@${host}`)) continue;
    if (account.length < 2) continue;
    add("prompt: account at host");
  }
  for (const match of ocrText.matchAll(HOME_PATH)) {
    if (!isNeutral(match[1] ?? "")) add("path: home directory");
  }
  if (RUN_ROOT.test(ocrText)) add("path: run root");
  if (OPT_ROOT.test(ocrText)) add("path: system install root");

  // A host name shown only as a UI label is deliberately out of scope: on a real capture OCR puts it beside a row label
  // like "Spaces", which no text rule can tell from a heading, and flagging headings failed 24 clean captures.

  return { ok: findings.length === 0, findings };
}

/** The entity forms an SVG's character data can carry: XML's five named ones, and a numeric one in decimal or hex. */
const SVG_ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi;
const NAMED_ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** An entity is one character to a reader, so it must be one character before the leak shapes are matched. */
const decodeEntities = (text: string): string =>
  text.replace(SVG_ENTITY, (whole: string, decimal?: string, hex?: string, named?: string): string => {
    if (named !== undefined) return NAMED_ENTITY[named.toLowerCase()] ?? whole;
    const codePoint = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number.parseInt(decimal, 10);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
  });

/**
 * The text a capture shows: an SVG's own character data (OCR cannot read one), any other image's OCR.
 * tesseract reads only the first frame of an animated GIF, so a leak shown in a later frame is out of its reach.
 */
export async function captureText(path: string): Promise<string> {
  if (/\.svg$/i.test(path)) {
    // Tags go with no separator: a prompt split across `<tspan>`s is one string to a reader, and a space where a tag
    // stood would let `someone@<tspan>alpha-box</tspan>` pass as two words. Entities decode after, so an
    // entity-encoded bracket is text and never a tag.
    return decodeEntities((await Bun.file(path).text()).replace(/<[^>]*>/g, ""));
  }
  const result = await $`tesseract ${path} -`
    .env({ ...process.env, OMP_THREAD_LIMIT: "1" })
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) throw new Error(`${path}: tesseract exited ${result.exitCode}`);
  return result.stdout.toString();
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const drain = async (): Promise<void> => {
    const index = next;
    next += 1;
    if (index >= items.length) return;
    out[index] = await run(items[index] as T);
    await drain();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return out;
}

if (import.meta.main) {
  const images = Bun.argv.slice(2);
  if (images.length === 0) {
    console.error("usage: bun tests/ci/capture-text.ts <image>...");
    process.exit(2);
  }
  const limit = Math.max(1, Math.min(8, cpus().length));
  const verdicts = await mapWithLimit(images, limit, async (image) => ({
    image,
    verdict: classify(await captureText(image)),
  }));
  let failed = 0;
  for (const { image, verdict } of verdicts) {
    if (verdict.ok) continue;
    failed += 1;
    console.error(`${image}: shows internal identifiers (${verdict.findings.map((one) => one.pattern).join(", ")})`);
  }
  if (failed > 0) {
    console.error(`${failed} image(s) must not be committed: re-capture with a neutral name and prompt (#926)`);
    process.exit(1);
  }
  console.log(`checked ${images.length} image(s), 0 with findings`);
}
