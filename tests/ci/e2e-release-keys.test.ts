import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const WORKFLOWS = join(import.meta.dir, "..", "..", ".github", "workflows");
const FLAG = "DORITERM_E2E_RELEASE_KEYS";

test("only CI's desktop e2e packaging builds with the e2e release keys; no other workflow, release.yml included, names them", () => {
  const naming = readdirSync(WORKFLOWS).filter((file) => readFileSync(join(WORKFLOWS, file), "utf8").includes(FLAG));
  expect(naming).toEqual(["ci.yml"]);
  const ci = Bun.YAML.parse(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8")) as Workflow;
  const setters = Object.values(ci.jobs).flatMap((job) =>
    (job.steps ?? []).filter((step) => step.env?.[FLAG] !== undefined),
  );
  expect(setters.map((step) => [step.name, step.run, step.env?.[FLAG]])).toEqual([
    ["Package (electron-builder --dir)", "bun run pack", "1"],
    ["Package (electron-builder --dir)", "bun run pack", "1"],
  ]);
});

test("release.yml checks the built main bundle for the e2e key before packaging it", () => {
  const release = Bun.YAML.parse(readFileSync(join(WORKFLOWS, "release.yml"), "utf8")) as Workflow;
  const steps = release.jobs["desktop"]?.steps ?? [];
  const built = steps.findIndex((step) => step.run?.includes("bun run build"));
  const guard = steps.findIndex(
    (step) => step.run?.includes("check-release-keys.ts") && step.run.includes("dist/app/main.js"),
  );
  const packaged = steps.findIndex((step) => step.name?.startsWith("Package"));
  expect(built).toBeGreaterThanOrEqual(0);
  expect(packaged).toBeGreaterThan(built);
  expect(guard).toBeGreaterThan(built);
  expect(guard).toBeLessThan(packaged);
});
