// Terminals another client starts while the app is open (`hc run --bg` from another terminal, a script, an agent) get
// a tab of their own, in the space their label names, on this core and on an added machine, without anyone clicking
// them. A change another client saves to the layout shows without a reload.
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { getCoreDoc, updateCoreDoc } from "./core-doc.ts";
import { tabs } from "./tab-strip.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import { STATE_BOUND_MS } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const started: { core: "host" | "machine"; address: string }[] = [];
test.afterEach(() => {
  for (const { core, address } of started.splice(0)) endAgent(core, address);
});

function startOutside(core: "host" | "machine", name: string, space: string): string {
  const address = startAgent(core, name, "working", space);
  started.push({ core, address });
  return address;
}

interface DocTab {
  readonly name: string;
  readonly root: unknown;
}
interface DocSpace {
  readonly name: string;
  readonly tabs: readonly DocTab[];
}

/** The names of the spaces whose tabs show the terminal, in the saved layout of its core. */
function spacesShowing(address: string, on?: string): string[] {
  const doc = getCoreDoc(LAYOUT_DOC, on) as { spaces?: readonly DocSpace[] } | null;
  return (doc?.spaces ?? []).flatMap((space) =>
    space.tabs.filter((tab) => JSON.stringify(tab.root).includes(`"terminal":"${address}"`)).map(() => space.name),
  );
}

test("an agent started outside the app on this core gets one tab in its labelled space without a click", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  const address = startOutside("host", "outside-lane", "lanes");
  await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual(["lanes"]);
});

test("an agent started outside the app on an added machine gets one tab in its labelled space without a click", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  await expect(page.getByText(MACHINE_NAME).first()).toBeVisible({ timeout: STATE_BOUND_MS });
  const address = startOutside("machine", "remote-lane", "lanes");
  await expect.poll(() => spacesShowing(address, MACHINE_NAME), { timeout: 30_000 }).toEqual(["lanes"]);
});

test("an agent opened from the Agents list before it has a tab goes to the space its label names", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const address = startOutside("host", "clicked-lane", "lanes");
  await agentRow(page, "clicked-lane", false).click();
  await expect(page.locator(`[data-terminal="${address}"]`)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual(["lanes"]);
});

test("a tab name another client saves shows without a reload", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await expect(tabs(page)).toHaveCount(1, { timeout: 20_000 });
  updateCoreDoc(LAYOUT_DOC, (current) => {
    const doc = structuredClone(current) as { spaces: { tabs: { name: string }[] }[] };
    for (const tab of doc.spaces.flatMap((space) => space.tabs)) tab.name = "renamed-outside";
    return doc;
  });
  await expect(tabs(page)).toHaveText(["renamed-outside"], { timeout: 20_000 });
});
