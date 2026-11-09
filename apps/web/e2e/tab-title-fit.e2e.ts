// #478, #466 and #1541: an unnamed tab that runs an agent reads the agent's title, with the agent's icon. A machine
// terminal's tab carries no machine label (tabs belong to a space and a space is one machine's, #404), and its only
// tooltip is the whole title when the tab cuts it short.
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { tabOf } from "./tab-strip.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const TITLE = "remote-build-pipeline-watcher";

test("the active tab of a machine's agent reads the agent's title with its icon, no machine label, and its long title as a tooltip", async ({
  page,
}) => {
  const address = startAgent("machine", TITLE, "idle");
  try {
    await page.goto("/");
    await agentRow(page, TITLE, true).click({ timeout: 20_000 });
    const tab = await tabOf(page, `${MACHINE_NAME}/${address}`);
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(tab).toHaveText(TITLE);
    await expect(tab).not.toContainText(MACHINE_NAME);
    await expect(tab).not.toHaveAttribute("title");
    // This title is wider than a tab's 170 px label, so the label carries the whole of it as its tooltip; nothing else
    // on the tab has one (#478).
    await expect(tab.locator("[title]")).toHaveCount(1);
    await expect(tab.locator("[title]")).toHaveAttribute("title", TITLE);
    await expect(tab.locator("svg.lucide-bot")).toHaveCount(1);
  } finally {
    endAgent("machine", address);
  }
});

test("an agent's title that fits its tab has no tooltip (#478)", async ({ page }) => {
  const address = startAgent("machine", "rev", "idle");
  try {
    await page.goto("/");
    await agentRow(page, "rev", true).click({ timeout: 20_000 });
    const tab = await tabOf(page, `${MACHINE_NAME}/${address}`);
    await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(tab).toHaveText("rev");
    await expect(tab.locator("[title]")).toHaveCount(0);
  } finally {
    endAgent("machine", address);
  }
});
