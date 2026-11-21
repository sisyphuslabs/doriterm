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
 * Records the first React commit that shows each requested title in the measured pane. Count every component that
 * did work in that commit (React's PerformedWork flag), skipping subtrees React kept as they were. Commits that leave
 * the title as it was, including late work from mounting the hidden panes, are not samples.
 */
function countRenders(address: string): void {
  const commits = new Map<string, number>();
  const terminal = `[data-terminal="${CSS.escape(address)}"]`;
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
        const label = document.querySelector(terminal)?.closest("section")?.getAttribute("aria-label");
        if (label?.startsWith("spin ") && !commits.has(label)) commits.set(label, rendered(root.current.child));
      },
    },
  });
  Object.defineProperty(window, "__titleCommits", { value: commits });
}

/** Each OSC title has to reach the pane in a React commit before the next title is sent. */
async function worstTitleCommit(
  page: Page,
  phase: "few" | "many",
  sendTitle: (title: string) => void,
): Promise<number> {
  const prefix = `spin ${phase}-`;
  for (let sample = 0; sample < 20; sample += 1) {
    const title = `${prefix}${sample}`;
    sendTitle(title);
    // oxlint-disable-next-line no-await-in-loop -- don't let React coalesce multiple titles into one commit
    const committed = await page.waitForFunction(
      (label) => Reflect.get(window, "__titleCommits").has(label) === true,
      `${title} terminal`,
      { timeout: 10_000 },
    );
    // oxlint-disable-next-line no-await-in-loop -- free this sample's handle before taking the next
    await committed.dispose();
  }
  return page.evaluate((startsWith) => {
    const commits: ReadonlyMap<string, number> = Reflect.get(window, "__titleCommits");
    return Math.max(...[...commits].filter(([label]) => label.startsWith(startsWith)).map(([, count]) => count));
  }, prefix);
}

test("a terminal's title change costs the same however many terminals sit in hidden tabs (#2086)", async ({ page }) => {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const hcRun = (args: readonly string[]): string =>
    execFileSync(hc, args, { env: { ...process.env, ...env }, encoding: "utf8" });
  const started: string[] = [];
  const start = (argv: readonly string[]): string => {
    const answer: unknown = JSON.parse(hcRun(["run", "--bg", "--json", "--", ...argv]));
    const address = String(Reflect.get(Object(answer), "address"));
    started.push(address);
    return address;
  };
  try {
    const spinner = start([
      "sh",
      "-c",
      "stty -echo; while IFS= read -r title; do printf '\\033]0;%s\\007' \"$title\"; done",
    ]);
    const sendTitle = (title: string): void => void hcRun(["send", "--force", spinner, title]);
    for (let index = 0; index < HIDDEN; index += 1) start(["sleep", "3600"]);
    await page.addInitScript(countRenders, spinner);
    // The sidebar's ages tick once a minute and redraw every agent row in one commit: a run crossing a minute would
    // measure that tick rather than a title change. Date.now stays put; every timer still runs (#2098).
    await page.clock.setFixedTime(Date.now());
    await page.goto("/");
    // Loose terminals are adopted into tabs on page load. Start sending titles once all panes have a renderer.
    const ready = page.locator('[data-terminal][data-ready="true"]');
    await expect(ready).toHaveCount(HIDDEN + 1, { timeout: 30_000 });
    const few = await worstTitleCommit(page, "few", sendTitle);
    for (let index = 0; index < HIDDEN; index += 1) start(["sleep", "3600"]);
    await page.reload();
    await expect(ready).toHaveCount(2 * HIDDEN + 1, { timeout: 30_000 });
    const many = await worstTitleCommit(page, "many", sendTitle);
    // Before #2086 each title change rendered every pane, sidebar row and tab again, many components each: twice the
    // terminals cost about twice as many renders per commit (2136 at 30 hidden terminals).
    // A loaded runner adds a few renders here and there; what this guards against grows by every hidden pane (#2098).
    expect(many - few, `title commit maxima: ${few} with ${HIDDEN} hidden, ${many} with ${2 * HIDDEN}`).toBeLessThan(
      HIDDEN,
    );
  } finally {
    for (const address of started) hcRun(["kill", address]);
    for (const address of started) hcRun(["rm", address]);
  }
});
