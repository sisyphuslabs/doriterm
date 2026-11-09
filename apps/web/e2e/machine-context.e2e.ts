import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";

const HOST_NAME = "studio";

test.describe("two terminals named alike on two machines", () => {
  const started: { core: "host" | "machine"; address: string }[] = [];
  test.beforeEach(() => {
    started.push({ core: "host", address: startAgent("host", "review", "idle") });
    started.push({ core: "machine", address: startAgent("machine", "review", "idle") });
  });
  test.afterEach(() => {
    for (const { core, address } of started.splice(0)) endAgent(core, address);
  });

  test("each machine's terminal is a tab of that machine's space, and the status bar says which machine is in view", async ({
    page,
  }) => {
    await page.goto("/");
    const bar = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
    const status = page.getByRole("contentinfo");

    // The tab bar shows the selected space's tabs, and a space is one machine's: a tab no longer names its machine (#404).
    // An unnamed tab that runs an agent reads the agent's title (#1541); the same name is on its session actions.
    const actions = page.getByRole("button", { name: "Session actions for review" });
    await agentRow(page, "review", true).click();
    await expect(bar).toHaveCount(1, { timeout: 15_000 });
    await expect(bar).toHaveText(["review"]);
    await expect(actions).toBeVisible();
    await expect(status).toContainText(MACHINE_NAME);

    await agentRow(page, "review", false).click();
    await expect(bar).toHaveCount(1);
    await expect(bar).toHaveText(["review"]);
    await expect(actions).toBeVisible();
    await expect(status).toContainText(HOST_NAME);
    await expect(status).not.toContainText(MACHINE_NAME);
  });

  test("the phone's terminal header names the machine and the space its tab is in", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await agentRow(page, "review", true).click();
    const header = page.locator("header").filter({ has: page.getByRole("button", { name: "Back to agents" }) });
    // Loaded with no tab of its own, the terminal was adopted into the space its `space` label names (#404): startAgent's
    // "api", on its own machine.
    await expect(header).toContainText(`${MACHINE_NAME} · api`, { timeout: 15_000 });
  });
});
