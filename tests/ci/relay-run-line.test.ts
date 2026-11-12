import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WEB = join(ROOT, "apps", "web");
const read = (path: string): string => readFileSync(path, "utf8");

type Step = { readonly run?: string };
type Workflow = { readonly jobs: Record<string, { readonly steps?: readonly Step[] }> };

// The specs that skip without a relay checkout: their skip line uses the shared PRIVATE_RELAY_SKIP reason.
const relayGated = (): readonly string[] =>
  readdirSync(join(WEB, "e2e"))
    .filter((name) => name.endsWith(".e2e.ts"))
    .filter((name) =>
      read(join(WEB, "e2e", name))
        .split("\n")
        .some((line) => /test\.skip\(.*PRIVATE_RELAY_SKIP/.test(line)),
    )
    .map((name) => `e2e/${name}`)
    .toSorted();

const relayRunLine = (): readonly string[] => {
  const workflow = Bun.YAML.parse(read(join(ROOT, ".github/workflows/ci.yml"))) as Workflow;
  const run =
    (workflow.jobs["relay-e2e"]?.steps ?? []).find((step) => step.run?.includes("bun run test:e2e"))?.run ?? "";
  return run.split(/\s+/).filter((word) => /^e2e\/.+\.e2e\.ts$/.test(word));
};

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
