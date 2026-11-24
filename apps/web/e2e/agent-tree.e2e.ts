import type { Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "tree2746";

const section = (page: Page, title: string) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: title, exact: true });

/**
 * A helper another agent started that reports `state` and waits, as `startAgent` does, and is kept when that agent's
 * program ends (`--outlive-parent`): by default hc ends a helper with the agent that started it.
 */
function startHelper(name: string, state: string, parent: string): string {
  const report = `printf '\\033]7501;state=${state}\\033\\\\'; sleep 600; :`;
  const out = hcOn("host", [
    "run",
    "--bg",
    "--parent",
    parent,
    "--outlive-parent",
    "--name",
    name,
    "--label",
    `space=${SPACE}`,
    "--",
    "sh",
    "-c",
    report,
  ]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** The rows of a section that are this spec's agents, by the name each starts with, in the order they are drawn. */
const drawn = (page: Page, title: string) => rows(section(page, title)).filter({ hasText: /tree-/ });

test("a sub-agent is listed under the agent that started it, which is placed by its most urgent one (#2746)", async ({
  page,
}) => {
  const lead = startAgent("host", "tree-lead", "working", SPACE);
  startAgent("host", "tree-other", "blocked", SPACE);
  const worker = startHelper("tree-worker", "done", lead);
  await page.goto("/");

  // A helper that finished is its own news: the agent that started it stays in Working, with the helper under it.
  await expect(drawn(page, "Working")).toHaveText([/tree-lead/, /tree-worker/], { timeout: 20_000 });
  await expect(drawn(page, "Needs you")).toHaveText([/tree-other/]);
  await expect(drawn(page, "Done")).toHaveCount(0);

  // A helper two levels down that needs the person brings the whole chain to Needs you, depth first.
  startHelper("tree-probe", "blocked", worker);
  await expect(drawn(page, "Needs you")).toHaveText([/tree-lead/, /tree-worker/, /tree-probe/, /tree-other/], {
    timeout: 20_000,
  });
  await expect(drawn(page, "Working")).toHaveCount(0);

  // The agent that started them ends: its helpers stay listed, the first of them now a row of its own, in the order they started.
  endAgent("host", lead);
  await expect(drawn(page, "Needs you")).toHaveText([/tree-other/, /tree-worker/, /tree-probe/], { timeout: 20_000 });
});
