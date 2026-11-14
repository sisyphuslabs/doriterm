// #2537: what a device keeps for itself (the tab it had open, a space's colour) is the same whichever host the page goes
// through. The second route is the e2e host's added machine with a gateway of its own (second-route.ts).
import type { Page } from "@playwright/test";
import { startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { FIRST_URL, routeThrough, type SecondRoute, startSecondRoute } from "./second-route.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

let second: SecondRoute | undefined;

test.beforeAll(async () => {
  second = await startSecondRoute();
});

test.afterAll(async () => {
  seedSpaces([]);
  await second?.stop();
});

const spaceRow = (page: Page, name: string) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("button", { name: new RegExp(`^${name}\\b`) });
const colourOf = async (page: Page, name: string): Promise<string | undefined> =>
  (await spaceRow(page, name).locator("span[aria-hidden]").first().getAttribute("class"))
    ?.split(/\s+/)
    .find((token) => token.startsWith("bg-avatar-"));
const selectedTab = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { selected: true });

test("the tab a device had open and a space's colour are the same after its route moves to the other host", async ({
  page,
}) => {
  const one = startAgent("host", "va-one", "idle", "vaone");
  const two = startAgent("host", "va-two", "idle", "vatwo");
  // The fixture's terminal guard ends the two agents once the test is over.
  seedSpaces([
    { id: "spc-vaone", name: "vaone", folder: "", tabs: [{ id: "tb-vaone", name: "one", terminal: one }] },
    { id: "spc-vatwo", name: "vatwo", folder: "", tabs: [{ id: "tb-vatwo", name: "two", terminal: two }] },
  ]);
  await routeThrough(page, FIRST_URL);
  await spaceRow(page, "vatwo").click();
  await expect(selectedTab(page)).toHaveText(/two/, { timeout: 20_000 });
  const colour = await colourOf(page, "vatwo");
  expect(colour).toBeDefined();

  const rerouted = await routeThrough(await page.context().newPage(), second?.url ?? "");
  await expect(selectedTab(rerouted)).toHaveText(/two/, { timeout: 20_000 });
  expect(await colourOf(rerouted, "vatwo")).toBe(colour);
});
