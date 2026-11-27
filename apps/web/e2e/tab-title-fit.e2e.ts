// #478, #466 and #1541: an unnamed tab that runs an agent reads the agent's title, with the agent's icon. A machine
// terminal's tab carries no machine label (tabs belong to a space and a space is one machine's, #404), and its only
// tooltip is the whole title when the tab cuts it short.
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { MACHINE_NAME } from "./machine.ts";
import { rows } from "./sidebar-measure.ts";
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
    // The tooltip has to be reachable: a pointer over the label lands on the element carrying the title (or inside it),
    // not on a hit layer drawn above it (#1530).
    const hovered = await tab.locator("[title]").evaluate((label) => {
      const box = label.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit?.closest("[title]")?.getAttribute("title") ?? null;
    });
    expect(hovered).toBe(TITLE);
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

const startOnHost = (args: readonly string[]): string => {
  const out = hcOn("host", ["run", "--bg", ...args]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  return String((parsed as { readonly address: unknown }).address);
};

const startLane = (name: string): string =>
  startOnHost(["--name", name, "--cwd", "/", "--", "bash", "-c", "exec sleep 600"]);

test("a lane's tab follows the lane's name when it is renamed after the tab is drawn (#2672 review)", async ({
  page,
}) => {
  const address = startLane("lane-before-rename");
  try {
    seedSpaces([
      { id: "spc-rename", name: "renames", folder: "", tabs: [{ id: "tb-rename", name: "", terminal: address }] },
    ]);
    await page.goto("/");
    const spacesRegion = page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Spaces" });
    await rows(spacesRegion).filter({ hasText: "renames" }).first().click();
    const tab = await tabOf(page, address);
    await expect(tab).toHaveText("lane-before-rename", { timeout: 15_000 });
    await page.getByRole("button", { name: "Session actions" }).click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await page
      .getByRole("dialog", { name: /^Rename / })
      .getByRole("textbox", { name: "Name" })
      .fill("lane-after-rename");
    await page.keyboard.press("Enter");
    await expect(tab).toHaveText("lane-after-rename", { timeout: 15_000 });
  } finally {
    endAgent("host", address);
  }
});

test("a lane's tab reads the lane's name, from the first lane on, never its place as a bare number (#2670)", async ({
  page,
}) => {
  const first = startLane("lane-doriterm-2670");
  const second = startLane("lane-relay-followups");
  try {
    seedSpaces([
      {
        id: "spc-lanes",
        name: "",
        folder: "",
        tabs: [
          { id: "tb-lane1", name: "", terminal: first },
          { id: "tb-lane2", name: "", terminal: second },
        ],
      },
    ]);
    await page.goto("/");
    const spacesRegion = page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Spaces" });
    await rows(spacesRegion).filter({ hasText: "Bash" }).first().click();
    const lane1 = await tabOf(page, first);
    const lane2 = await tabOf(page, second);
    await expect(lane1).toHaveText("lane-doriterm-2670", { timeout: 15_000 });
    await expect(lane2).toHaveText("lane-relay-followups");
  } finally {
    endAgent("host", first);
    endAgent("host", second);
  }
});
