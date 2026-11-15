// The tabs mirror the core's terminals on every path, as herdr-app's reconcile keeps them (Q, 2026-11-15): a terminal
// gets a tab however it was started, loses it however it was removed or ended (in view or not), shows a rename or a
// move another client makes, and the same holds across an app restart. No spec clicks to make any of it happen.
import type { Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { updateCoreDoc } from "./core-doc.ts";
import { type DocSpace, spaceRow, spacesShowing } from "./core-tabs.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import { removeTerminal, stateOn } from "./ended-terminal.ts";
import { hcOn, STATE_BOUND_MS } from "./machine-switch.ts";
import { selectedPane, tabOf } from "./tab-strip.ts";

test.use({ serviceWorkers: "block" });

const started: { core: "host" | "machine"; address: string }[] = [];
test.afterEach(() => {
  for (const { core, address } of started.splice(0)) {
    try {
      endAgent(core, address);
    } catch {
      // Removed by the spec itself.
    }
  }
});

function start(core: "host" | "machine", name: string, space: string, parent?: string): string {
  const address = startAgent(core, name, "working", space, parent);
  started.push({ core, address });
  return address;
}

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await openNewTerminal(page);
}

/** An agent started outside the app, with its tab once adoption has written it. */
async function adopted(page: Page, name: string, space: string): Promise<string> {
  const address = start("host", name, space);
  await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual([space]);
  await expect(agentRow(page, name, false)).toBeVisible();
  return address;
}

/** Shows the agent's tab: its row opens the tab it already has. */
async function inView(page: Page, name: string, address: string): Promise<void> {
  await agentRow(page, name, false).click();
  await expect(selectedPane(page, address)).toHaveCount(1, { timeout: 20_000 });
}

test("an agent another agent started on an added machine gets its own tab there without a click", async ({ page }) => {
  await open(page);
  await expect(page.getByText(MACHINE_NAME).first()).toBeVisible({ timeout: STATE_BOUND_MS });
  const lead = start("machine", "far-lead", "farlanes");
  await expect.poll(() => spacesShowing(lead, MACHINE_NAME), { timeout: 30_000 }).toEqual(["farlanes"]);
  const worker = start("machine", "far-worker", "farlanes", lead);
  await expect.poll(() => spacesShowing(worker, MACHINE_NAME), { timeout: 30_000 }).toEqual(["farlanes"]);
});

test("a terminal removed from the core outside the app loses its tab, also the one in view", async ({ page }) => {
  await open(page);
  const address = await adopted(page, "rm-lane", "rmlanes");
  await inView(page, "rm-lane", address);
  endAgent("host", address);
  await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual([]);
  await expect(selectedPane(page, address)).toHaveCount(0);
});

test("a terminal whose program ended outside the app loses its tab, also the one in view", async ({ page }) => {
  await open(page);
  const address = await adopted(page, "end-lane", "endlanes");
  await inView(page, "end-lane", address);
  hcOn("host", ["kill", address]);
  await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual([]);
  await expect(selectedPane(page, address)).toHaveCount(0);
});

test("a tab in view whose terminal ended while no view was attached is gone after a reload, not left saying it ended", async ({
  page,
}) => {
  await open(page);
  const address = await adopted(page, "gone-lane", "gonelanes");
  await inView(page, "gone-lane", address);
  await page.close();
  hcOn("host", ["kill", address]);
  const again = await page.context().newPage();
  await again.goto("/");
  await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual([]);
  await expect(again.getByRole("heading", { name: "This session ended" })).toHaveCount(0);
});

/** herdr-app's just-born grace (`just_born`, window.rs), as use-dead-panes.ts keeps it. */
const JUST_BORN_MS = 5_000;

test("a program that fails at launch in the tab in view keeps its pane for the just-born grace, then its tab goes", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  try {
    hcOn("host", ["send", address, "exit"]);
    await expect.poll(() => stateOn("host", address), { timeout: 15_000 }).toBe("finished");
    const record = JSON.parse(hcOn("host", ["get", address, "--json"])) as { created_ms: number; finished_ms: number };
    // It ended well inside its grace, so a drop at the end of the stream would come before the grace is over.
    expect(record.finished_ms - record.created_ms).toBeLessThan(JUST_BORN_MS - 2_000);
    await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual([]);
    expect(Date.now()).toBeGreaterThanOrEqual(record.created_ms + JUST_BORN_MS);
  } finally {
    removeTerminal("host", address);
  }
});

test("a terminal removed outside the app while its tab is out of view loses its tab", async ({ page }) => {
  await open(page);
  const address = await adopted(page, "hidden-lane", "hiddenlanes");
  endAgent("host", address);
  await expect.poll(() => spacesShowing(address), { timeout: 20_000 }).toEqual([]);
});

test("a rename another device makes shows on the agent's tab without a reload", async ({ page }) => {
  await open(page);
  const address = await adopted(page, "name-lane", "namelanes");
  await inView(page, "name-lane", address);
  hcOn("host", ["label", address, "herdr.name=renamed-lane"]);
  await expect(await tabOf(page, address)).toContainText("renamed-lane", { timeout: 20_000 });
});

test("a tab another client moves to another space moves here without a reload, and the counts follow", async ({
  page,
}) => {
  await open(page);
  const address = await adopted(page, "move-lane", "movefrom");
  await expect(spaceRow(page, "movefrom").getByLabel(/^\d+ tabs$/)).toHaveText("1");
  updateCoreDoc(LAYOUT_DOC, (current) => {
    const doc = current as { spaces: DocSpace[] };
    const from = doc.spaces.find((space) => space.name === "movefrom");
    const moving = from?.tabs.filter((tab) => JSON.stringify(tab.root).includes(`"terminal":"${address}"`)) ?? [];
    const spaces = doc.spaces.map((space) =>
      space === from ? { ...space, tabs: space.tabs.filter((tab) => !moving.includes(tab)) } : space,
    );
    return { ...doc, spaces: [...spaces, { id: "spc-moveto", name: "moveto", folder: "", tabs: moving }] };
  });
  await expect(spaceRow(page, "moveto").getByLabel(/^\d+ tabs$/)).toHaveText("1", { timeout: 20_000 });
  await expect(spaceRow(page, "movefrom").getByLabel(/^\d+ tabs$/)).toHaveText("0");
  // The moved tab is the person's placement now: adoption never writes a second tab for it.
  await expect.poll(() => spacesShowing(address), { timeout: 10_000 }).toEqual(["moveto"]);
});

test("across an app restart, a terminal started while the app was closed gets its tab and one removed loses it", async ({
  page,
}) => {
  const before = start("host", "boot-lane", "bootlanes");
  await open(page);
  await expect.poll(() => spacesShowing(before), { timeout: 20_000 }).toEqual(["bootlanes"]);
  await page.close();
  endAgent("host", before);
  const after = start("host", "boot-late", "bootlanes");
  const again = await page.context().newPage();
  await again.goto("/");
  await expect.poll(() => spacesShowing(after), { timeout: 20_000 }).toEqual(["bootlanes"]);
  await expect.poll(() => spacesShowing(before), { timeout: 20_000 }).toEqual([]);
});
