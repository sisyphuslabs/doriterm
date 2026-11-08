import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluate, type Value } from "./gh-expression.ts";

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string };
type Job = { needs?: string; if?: string; steps: Step[] };
type Workflow = { concurrency: { group: string; "cancel-in-progress": string | boolean }; jobs: Record<string, Job> };
type Route = { pattern: string; zone_id?: string; custom_domain?: boolean };
type Assets = { directory: string; not_found_handling?: string };
type Wrangler = { assets: Assets; routes: Route[]; env: { staging: { assets: Assets; routes: Route[] } } };

const ROOT = join(import.meta.dir, "..", "..");
const workflow = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "deploy-web.yml"), "utf8")) as Workflow;
const wrangler = Bun.JSONC.parse(readFileSync(join(ROOT, "apps", "web", "wrangler.jsonc"), "utf8")) as Wrangler;

const runs = (job: Job): string[] => job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

/** The github and inputs contexts of one event that starts this workflow. */
type Event = { github: Record<string, Value>; inputs?: Record<string, Value> };
const push: Event = { github: { event_name: "push", ref: "refs/heads/dev", run_id: 101 } };
const pullRequest: Event = {
  github: { event_name: "pull_request", ref: "refs/pull/7/merge", run_id: 102, event: { pull_request: { number: 7 } } },
};
const dispatch = (ref: string, production: boolean): Event => ({
  github: { event_name: "workflow_dispatch", ref, run_id: 103 },
  inputs: { production },
});
const group = (event: Event): Value => evaluate(workflow.concurrency.group, { contexts: event });
const cancels = (event: Event): Value =>
  evaluate(String(workflow.concurrency["cancel-in-progress"]), { contexts: event });

// A group keeps one pending run, so whatever shares dev's group can replace a pending dev push run (#868, #884).
test("only what deploys dev to production shares dev's concurrency group, and dev deploys are never cancelled", () => {
  expect([group(push), cancels(push)]).toEqual(["deploy-web-dev", false]);
  expect([group(dispatch("refs/heads/dev", true)), cancels(dispatch("refs/heads/dev", true))]).toEqual([
    "deploy-web-dev",
    false,
  ]);
  expect([group(pullRequest), cancels(pullRequest)]).toEqual(["deploy-web-pr-7", true]);
  for (const manual of [dispatch("refs/heads/dev", false), dispatch("refs/heads/feature", true)]) {
    expect(group(manual)).not.toBe("deploy-web-dev");
    expect(group(manual)).toContain(String(manual.github["run_id"]));
  }
});

test("a manual run from any branch but dev stops before it builds or deploys anything", () => {
  const { staging } = workflow.jobs;
  if (staging === undefined) throw new Error("deploy-web.yml lacks a staging job");
  const stops = (event: Event): boolean => {
    const first = staging.steps[0];
    return (
      first?.if !== undefined && evaluate(first.if, { contexts: event }) === true && /exit 1\s*$/.test(first.run ?? "")
    );
  };
  expect(evaluate(staging.if ?? "true", { contexts: dispatch("refs/heads/feature", true) })).toBe(true);
  expect([stops(dispatch("refs/heads/feature", false)), stops(dispatch("refs/heads/dev", false)), stops(push)]).toEqual(
    [true, false, false],
  );
});

test("production deploys only from dev, after staging was deployed and probed, from staging's own build", () => {
  const { staging, production } = workflow.jobs;
  if (staging === undefined || production === undefined) throw new Error("deploy-web.yml lacks a job");
  expect(production.needs).toBe("staging");
  expect(production.if).toContain("github.ref == 'refs/heads/dev'");
  expect(runs(staging).slice(-3)).toEqual([
    'bunx "$WRANGLER" deploy --env staging',
    "bun .github/scripts/probe-web.ts https://staging.app.doriterm.com",
    "bun .github/scripts/probe-web.ts https://doriface-staging.omo.dev",
  ]);
  expect(runs(staging)).not.toContain('bunx "$WRANGLER" deploy --env ""');
  expect(runs(production)).toEqual([
    'bun .github/scripts/deploy-target.ts apps/web/wrangler.jsonc "" doriface-web app.doriterm.com doriface.omo.dev',
    'bunx "$WRANGLER" deploy --env ""',
    "bun .github/scripts/probe-web.ts https://app.doriterm.com",
    "bun .github/scripts/probe-web.ts https://doriface.omo.dev",
  ]);
  expect(production.steps.some((step) => step.uses?.startsWith("actions/download-artifact"))).toBe(true);
});

// #929: a deploy that failed leaves nothing new to probe; each probe retries for minutes, so probing then only burns time.
test("each host is probed only after that job's deploy succeeded, and a failed probe does not skip the next host", () => {
  for (const job of Object.values(workflow.jobs)) {
    const deploy = job.steps.findIndex((step) => step.run?.startsWith('bunx "$WRANGLER" deploy'));
    const deployId = job.steps[deploy]?.id;
    const probes = job.steps.slice(deploy + 1).filter((step) => step.run?.includes("probe-web.ts"));
    expect(probes.length).toBe(2);
    const probed = (outcome: string, status: "success" | "failure"): boolean[] =>
      probes.map((probe) =>
        Boolean(
          evaluate(probe.if ?? "success()", {
            contexts: { steps: deployId === undefined ? {} : { [deployId]: { outcome } } },
            status,
          }),
        ),
      );
    expect(probed("failure", "failure")).toEqual([false, false]);
    expect(probed("success", "failure")).toEqual([false, true]);
    expect(probed("success", "success")).toEqual([true, true]);
  }
});

test("app.doriterm.com and the omo.dev host each serve the build with the SPA fallback, so /pair loads the app", () => {
  const DORITERM_ZONE = "79ae74d5937b2858a42f6261887e436e";
  expect(wrangler.routes).toEqual([
    { pattern: "app.doriterm.com", zone_id: DORITERM_ZONE, custom_domain: true },
    { pattern: "doriface.omo.dev", custom_domain: true },
  ]);
  expect(wrangler.env.staging.routes).toEqual([
    { pattern: "staging.app.doriterm.com", zone_id: DORITERM_ZONE, custom_domain: true },
    { pattern: "doriface-staging.omo.dev", custom_domain: true },
  ]);
  for (const assets of [wrangler.assets, wrangler.env.staging.assets]) {
    expect(assets).toEqual({ directory: "./dist", not_found_handling: "single-page-application" });
  }
});

test("every page runs only this origin's scripts and connects only to this origin and the relay", async () => {
  const headersFile = readFileSync(join(ROOT, "apps", "web", "public", "_headers"), "utf8");
  const policy = /^\/\*\n(?:  .*\n)*?  Content-Security-Policy: (.+)$/m.exec(headersFile)?.[1] ?? "";
  const directives = new Map(
    policy.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
  expect(directives.get("default-src")).toEqual(["'none'"]);
  expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(directives.get("connect-src")).toEqual([
    "'self'",
    "https://relay-doriface.omo.dev",
    "wss://relay-doriface.omo.dev",
  ]);
  expect(directives.get("style-src")).toEqual(["'self'", `'sha256-${await baseUiScrollbarStyleHash()}'`]);
  expect(directives.get("img-src")).toEqual(["'self'"]);
  expect(directives.get("font-src")).toEqual(["'self'", "data:"]);
  for (const name of ["frame-ancestors", "base-uri", "form-action", "object-src"]) {
    expect(directives.get(name)).toEqual(["'none'"]);
  }
  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).not.toContain("'unsafe-inline'");
});

/**
 * The CSP hash of the <style> @base-ui/react renders to hide scrollbars: the element it renders, from the ESM build the
 * web bundle imports, so the hash follows what ships rather than a reading of its source.
 */
async function baseUiScrollbarStyleHash(): Promise<string> {
  const root = dirname(Bun.resolveSync("@base-ui/react/scroll-area", join(ROOT, "packages", "ui")));
  const styles: unknown = await import(join(root, "..", "utils", "styles.mjs"));
  const element: unknown = Reflect.get(Reflect.get(Object(styles), "styleDisableScrollbar"), "getElement")(undefined);
  const css: unknown = Reflect.get(Reflect.get(Object(element), "props"), "children");
  if (typeof css !== "string") throw new Error("@base-ui/react's scrollbar style is no longer one string");
  return new Bun.CryptoHasher("sha256").update(css).digest("base64");
}

/** One page's meta tag content: apps/<page>/index.html, <meta property|name="<key>">. */
const metaOf = (page: string, key: string): string | undefined =>
  new RegExp(`<meta (?:property|name)="${key}" content="([^"]+)"`).exec(
    readFileSync(join(ROOT, "apps", page, "index.html"), "utf8"),
  )?.[1];

test("both sites preview with one card at a URL that changes with the card, so crawlers refetch it", () => {
  const card = readFileSync(join(ROOT, "apps", "landing", "public", "og.png"));
  const hash = new Bun.CryptoHasher("sha256").update(card).digest("hex").slice(0, 8);
  // A new card needs this query in both index.html files; crawlers cache the image by its URL.
  const url = `https://doriterm.com/og.png?v=${hash}`;
  for (const page of ["landing", "web"]) {
    expect(metaOf(page, "og:image")).toBe(url);
    expect(metaOf(page, "twitter:image")).toBe(url);
    expect(metaOf(page, "og:title")).toBe("Doriterm: Your devices. One terminal.");
  }
  // The GitHub social preview is uploaded from this copy, so the repo and the sites show one card.
  expect(readFileSync(join(ROOT, ".github", "social-preview.png")).equals(card)).toBe(true);
});
