// #478, #466 and #1541: an unnamed tab that runs an agent reads the agent's title, with the agent's icon. A machine
// terminal's tab carries no machine label (tabs belong to a space and a space is one machine's, #404) and has no tooltip.
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { tabOf } from "./tab-strip.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const TITLE = "remote-build-pipeline-watcher";

test("the active tab of a machine's agent reads the agent's title with its icon: no machine label or tooltip", async ({
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
    await expect(tab.locator("[title]")).toHaveCount(0);
    await expect(tab.locator("svg.lucide-bot")).toHaveCount(1);
  } finally {
    endAgent("machine", address);
  }
});
