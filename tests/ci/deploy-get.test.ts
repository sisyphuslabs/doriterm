import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bindingProblems, exposure, liveVersion } from "../../.github/scripts/get-deploy.ts";

type Step = { name?: string; run?: string; if?: string; id?: string };
type Job = { needs?: string; if?: string; environment?: string; steps: Step[] };
type Workflow = { on: { push: { paths: string[] }; pull_request: { paths: string[] } }; jobs: Record<string, Job> };

const ROOT = join(import.meta.dir, "..", "..");
const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "deploy-get.yml"), "utf8")) as Workflow;
const wranglerText = readFileSync(join(ROOT, "apps", "get", "wrangler.jsonc"), "utf8");
const wrangler: unknown = Bun.JSONC.parse(wranglerText);

const runs = (job: Job | undefined): string[] => (job?.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
const at = (steps: string[], needle: string): number => steps.findIndex((run) => run.includes(needle));

test("each environment checks its target, its bindings and its bucket's privacy before it migrates and deploys", () => {
  for (const [name, env, worker, bucket, origin] of [
    ["staging", "staging", "doriterm-get-staging", "doriterm-releases-staging", "https://staging.get.doriterm.com"],
    ["production", '""', "doriterm-get", "doriterm-releases", "https://get.doriterm.com"],
  ] as const) {
    const steps = runs(workflow.jobs[name]);
    const order = [
      at(steps, `deploy-target.ts apps/get/wrangler.jsonc ${env} ${worker}`),
      at(steps, `get-deploy.ts bindings apps/get/wrangler.jsonc ${env}`),
      at(steps, `get-deploy.ts private ${bucket}`),
      at(steps, `get-deploy.ts live ${worker}`),
      at(steps, "d1 migrations apply"),
      at(steps, `deploy --env ${env} --var "ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID"`),
      at(steps, `probe-get.ts ${origin}`),
      at(steps, 'rollback "$VERSION"'),
    ];
    expect([name, order.every((index, i) => index >= 0 && (i === 0 || index > (order[i - 1] ?? 0)))]).toEqual([
      name,
      true,
    ]);
    const rollback = workflow.jobs[name]?.steps.at(-1);
    expect(rollback?.if).toBe("failure() && steps.deploy.outcome == 'success' && steps.live.outputs.version != 'none'");
  }
});

test("production runs only from a manual run on dev after staging, and a pull request reaches staging only by label", () => {
  const { staging, production } = workflow.jobs;
  expect(production?.needs).toBe("staging");
  expect(production?.environment).toBe("production");
  expect(production?.if).toBe(
    "github.ref == 'refs/heads/dev' && github.event_name == 'workflow_dispatch' && inputs.production",
  );
  expect(staging?.if).toContain("contains(github.event.pull_request.labels.*.name, 'deploy-staging')");
  expect(staging?.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  expect(runs(staging).some((run) => run.includes('--env ""'))).toBe(false);
  expect(workflow.on.pull_request.paths).toEqual(workflow.on.push.paths);
  expect(workflow.on.push.paths).toContain("apps/get/**");
});

test("wrangler.jsonc binds each environment to its own data, keeps no request log and holds no account, zone or id", () => {
  expect(bindingProblems(wrangler, "")).toEqual([]);
  expect(bindingProblems(wrangler, "staging")).toEqual([]);
  expect(wranglerText).not.toMatch(/account_id|zone_id|database_id|[0-9a-f]{32}/);
  const swapped = JSON.parse(JSON.stringify(wrangler));
  swapped.env.staging.r2_buckets = [{ binding: "RELEASES", bucket_name: "doriterm-releases" }];
  swapped.env.staging.observability = { enabled: true };
  swapped.env.staging.vars.ANALYTICS_TOKEN = "x";
  expect(bindingProblems(swapped, "staging")).toEqual([
    'the R2 bucket is ["doriterm-releases"], not [doriterm-releases-staging]',
    "observability is not off",
    "ANALYTICS_TOKEN is written in the file",
  ]);
});

test("a section that would ship request events off the Worker, by Logpush or a tail consumer, is refused (#1981)", () => {
  const shipping = JSON.parse(JSON.stringify(wrangler));
  shipping.env.staging.logpush = true;
  shipping.env.staging.tail_consumers = [{ service: "doriterm-tail" }];
  expect(bindingProblems(shipping, "staging")).toEqual(["logpush is on", "it has tail consumers (1)"]);
  // Production is the top-level section; a named environment that sets neither key is held to the top-level values.
  const inherited = JSON.parse(JSON.stringify(wrangler));
  inherited.logpush = true;
  inherited.tail_consumers = [{ service: "doriterm-tail" }];
  expect(bindingProblems(inherited, "")).toEqual(["logpush is on", "it has tail consumers (1)"]);
  expect(bindingProblems(inherited, "staging")).toEqual(["logpush is on", "it has tail consumers (1)"]);
  inherited.env.staging.logpush = false;
  inherited.env.staging.tail_consumers = [];
  expect(bindingProblems(inherited, "staging")).toEqual([]);
});

test("a bucket with an r2.dev URL or a custom domain is public, and the live version is the one most traffic gets", () => {
  expect(exposure({ enabled: false }, { domains: [] })).toEqual([]);
  expect(exposure({ enabled: true }, { domains: [{ domain: "files.example" }] })).toEqual([
    "its r2.dev URL is not disabled",
    "it has custom domains (1)",
  ]);
  expect(exposure(undefined, undefined)).toEqual(["its r2.dev URL is not disabled"]);
  const a = "11111111-2222-3333-4444-555555555555";
  const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  expect(
    liveVersion({
      deployments: [
        {
          versions: [
            { version_id: a, percentage: 10 },
            { version_id: b, percentage: 90 },
          ],
        },
      ],
    }),
  ).toBe(b);
  expect(liveVersion({ deployments: [] })).toBe("none");
  expect(liveVersion({ deployments: [{ versions: [{ version_id: "$(rm -rf /)", percentage: 100 }] }] })).toBe("none");
});
