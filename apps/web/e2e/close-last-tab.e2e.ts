import { startShell } from "./agents.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) hcOn("host", ["kill", address]);
});

test("closing the only tab ends its shell and empties the workspace; a terminal outside any tab waits in the sidebar, also after a reload (#354, #409)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(1);
  const running = (await terminalCount(page)).before;

  // Cmd+W on macOS; the pane close key elsewhere.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyW" : "Control+Shift+X");
  await expect(page.getByRole("contentinfo")).toContainText(`${running - 1} terminal`, { timeout: 15_000 });
  await expect(tabs).toHaveCount(0);
  await expect(page.locator(`[data-terminal="${address}"]`)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A terminal started outside the app (or kept running by an older build) is in no tab: the emptied layout leaves it
  // in the sidebar rather than showing it alone.
  started.push(startShell("host", "outside-any-tab"));
  await expect(page.getByRole("contentinfo")).toContainText(`${running} terminal`, { timeout: 15_000 });
  await expect(tabs).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("contentinfo")).toContainText(`${running} terminal`, { timeout: 20_000 });
  await expect(tabs).toHaveCount(0);
});
