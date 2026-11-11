import { execFileSync } from "node:child_process";
import { E2E_HOST_ENV } from "./config.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { readSavedEnv } from "./saved-env.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** Terminals that sit in hidden tabs, each a mounted pane, while one other terminal changes its title (#2086). */
const HIDDEN = 30;

/**
 * Counts, for every commit React makes, the components it rendered again, the way React DevTools tells them: a
 * component that did work (React's PerformedWork flag), skipping any subtree React kept as it was. React reports each
 * commit to this hook when it finds one installed before the app loads.
 */
function countRenders(): void {
  const commits: number[] = [];
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  type Fiber = {
    readonly tag: number;
    readonly flags: number;
    readonly child: Fiber | null;
    readonly sibling: Fiber | null;
    readonly alternate: Fiber | null;
  };
  const rendered = (first: Fiber | null): number => {
    let count = 0;
    const stack: Fiber[] = first === null ? [] : [first];
    for (let fiber = stack.pop(); fiber !== undefined; fiber = stack.pop()) {
      if (fiber.sibling !== null) stack.push(fiber.sibling);
      if (COMPONENT_TAGS.has(fiber.tag) && (fiber.flags & 1) !== 0) count += 1;
      const kept = fiber.alternate !== null && fiber.alternate.child === fiber.child;
      if (fiber.child !== null && !kept) stack.push(fiber.child);
    }
    return count;
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    value: {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => undefined,
      onScheduleFiberRoot: () => undefined,
      onCommitFiberUnmount: () => undefined,
      onPostCommitFiberRoot: () => undefined,
      onCommitFiberRoot: (_renderer: number, root: { readonly current: Fiber }) => {
        commits.push(rendered(root.current.child));
      },
    },
  });
  Object.defineProperty(window, "__commits", { value: commits });
}

/** The most components any one commit rendered again, over twenty commits of the spinning title from now on. */
async function worstCommit(page: Page): Promise<number> {
  const from = await page.evaluate(() => Reflect.get(window, "__commits").length);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__commits").length), { timeout: 20_000 })
    .toBeGreaterThan(from + 20);
  const commits: number[] = await page.evaluate((skip) => Reflect.get(window, "__commits").slice(skip), from);
  return Math.max(...commits);
}

test("a terminal's title change costs the same however many terminals sit in hidden tabs (#2086)", async ({ page }) => {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const hcRun = (args: readonly string[]): string =>
    execFileSync(hc, args, { env: { ...process.env, ...env }, encoding: "utf8" });
  const started: string[] = [];
  const start = (argv: readonly string[]): void => {
    const answer: unknown = JSON.parse(hcRun(["run", "--bg", "--json", "--", ...argv]));
    started.push(String(Reflect.get(Object(answer), "address")));
  };
  try {
    start(["sh", "-c", "i=0; while :; do printf '\\033]0;spin %d\\007' $i; i=$((i+1)); sleep 0.1; done"]);
    for (let index = 0; index < HIDDEN; index += 1) start(["sleep", "3600"]);
    await page.addInitScript(countRenders);
    await page.goto("/");
    // Every terminal is listed, and the loose ones are adopted into tabs as the page loads, each pane mounted.
    await expect(page.locator("[data-terminal]")).toHaveCount(HIDDEN + 1, { timeout: 30_000 });
    const few = await worstCommit(page);
    for (let index = 0; index < HIDDEN; index += 1) start(["sleep", "3600"]);
    await page.reload();
    await expect(page.locator("[data-terminal]")).toHaveCount(2 * HIDDEN + 1, { timeout: 30_000 });
    const many = await worstCommit(page);
    // Before #2086 each title change rendered every pane, sidebar row and tab again, many components each: twice the
    // terminals cost about twice as many renders per commit (2136 at 30 hidden terminals).
    expect(many - few).toBeLessThan(HIDDEN / 3);
  } finally {
    for (const address of started) hcRun(["kill", address]);
    for (const address of started) hcRun(["rm", address]);
  }
});
