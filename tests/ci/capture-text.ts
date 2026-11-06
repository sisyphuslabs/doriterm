import { $ } from "bun";

/**
 * Screenshots in a public repository must not show an account name, a host name or an internal path. A reviewer's eye
 * missed five of these for weeks (#926), so the check is mechanical: OCR the image and match the shapes those leak in.
 *
 * The patterns describe the SHAPE, never the value. A list of the actual fleet names would put them back in the repo.
 */
export const NEUTRAL_NAMES: ReadonlySet<string> = new Set([
  "demo",
  "user",
  "me",
  "you",
  "example",
  "project",
  "laptop",
  "my-laptop",
  "box",
  "sandbox",
  "dev",
]);

export const LEAK_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "path: home directory", pattern: /(?:\/Users\/|\/home\/)[A-Za-z]/ },
  { name: "path: run root", pattern: /\/(?:srv|opt|var\/tmp|private\/tmp)\/[A-Za-z]/i },
  { name: "host: ssh target", pattern: /\bssh\s+[a-z][a-z0-9._-]*@[a-z]/i },
];

const PROMPT = /\b([a-z][a-z0-9._-]{1,})@([a-z][a-z0-9-]{1,})[:~]/gi;

export interface Verdict {
  readonly ok: boolean;
  readonly findings: readonly { readonly pattern: string }[];
}

/** Which patterns a piece of OCR text trips, by name only: the matched text is the leak and is never returned. */
export function classify(ocrText: string): Verdict {
  const findings = LEAK_PATTERNS.filter((one) => one.pattern.test(ocrText)).map((one) => ({ pattern: one.name }));
  for (const match of ocrText.matchAll(PROMPT)) {
    const account = match[1] ?? "";
    const host = match[2] ?? "";
    if (NEUTRAL_NAMES.has(account.toLowerCase()) && NEUTRAL_NAMES.has(host.toLowerCase())) continue;
    findings.push({ pattern: "prompt: account@host" });
    break;
  }
  return { ok: findings.length === 0, findings };
}

async function ocr(path: string): Promise<string> {
  const result = await $`tesseract ${path} -`.quiet().nothrow();
  if (result.exitCode !== 0) throw new Error(`${path}: tesseract exited ${result.exitCode}`);
  return result.stdout.toString();
}

if (import.meta.main) {
  const images = Bun.argv.slice(2);
  if (images.length === 0) {
    console.error("usage: bun tests/ci/capture-text.ts <image>...");
    process.exit(2);
  }
  const verdicts = await Promise.all(images.map(async (image) => ({ image, verdict: classify(await ocr(image)) })));
  let failed = 0;
  for (const { image, verdict } of verdicts) {
    if (verdict.ok) continue;
    failed += 1;
    const names = verdict.findings.map((one) => one.pattern).join(", ");
    console.error(`${image}: shows internal identifiers (${names})`);
  }
  if (failed > 0) {
    console.error(`${failed} image(s) must not be committed: re-capture with a neutral name and prompt (#926)`);
    process.exit(1);
  }
}
