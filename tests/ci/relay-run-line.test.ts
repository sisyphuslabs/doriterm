import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WEB = join(ROOT, "apps", "web");
const read = (path: string): string => readFileSync(path, "utf8");

type Step = { readonly run?: string };
type Workflow = { readonly jobs: Record<string, { readonly steps?: readonly Step[] }> };

// A spec skips without a relay checkout when a test.skip( call passes the shared PRIVATE_RELAY_SKIP reason. The call may
// be wrapped over several lines (the formatter breaks long calls), so the match spans line breaks up to the call's end.
const skipsWithoutRelay = (source: string): boolean => /test\.skip\([^;]*?PRIVATE_RELAY_SKIP/s.test(source);

const relayGated = (): readonly string[] =>
  readdirSync(join(WEB, "e2e"))
    .filter((name) => name.endsWith(".e2e.ts"))
    .filter((name) => skipsWithoutRelay(read(join(WEB, "e2e", name))))
    .map((name) => `e2e/${name}`)
    .toSorted();

const relayRunLine = (): readonly string[] => {
  const workflow = Bun.YAML.parse(read(join(ROOT, ".github/workflows/ci.yml"))) as Workflow;
  const run =
    (workflow.jobs["relay-e2e"]?.steps ?? []).find((step) => step.run?.includes("bun run test:e2e"))?.run ?? "";
  return run.split(/\s+/).filter((word) => /^e2e\/.+\.e2e\.ts$/.test(word));
};

test("a relay-gated skip is recognised when the formatter wraps it, and only a skip with the shared reason counts", () => {
  expect(skipsWithoutRelay('test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);')).toBe(
    true,
  );
  const wrapped = [
    "test.skip(",
    '  process.env["DORIFACE_RELAY_DIR"] === undefined || process.env["SOME_OTHER_LONG_CONDITION"] === undefined,',
    "  PRIVATE_RELAY_SKIP,",
    ");",
  ].join("\n");
  expect(skipsWithoutRelay(wrapped)).toBe(true);
  expect(skipsWithoutRelay('test.skip(isMobile, "phone only");\nconst reason = PRIVATE_RELAY_SKIP;')).toBe(false);
});

test("the Relay e2e browser step runs every spec that skips without the relay checkout (#2376)", () => {
  const gated = relayGated();
  // Neither side may be empty: a scan that found nothing proves nothing.
  expect(gated.length).toBeGreaterThan(0);
  const named = relayRunLine();
  expect(named.length).toBeGreaterThan(0);
  expect(gated.filter((spec) => !named.includes(spec))).toEqual([]);
});

test("every spec the Relay e2e browser step names exists, so none of its entries runs nothing (#2376)", () => {
  const named = relayRunLine();
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((spec) => !existsSync(join(WEB, spec)))).toEqual([]);
});
