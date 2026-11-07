import { startShell } from "./agents.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) hcOn("host", ["kill", address]);
});

test("closing the only tab asks Close space?, ends its shell and empties the workspace; a terminal outside any tab is not shown alone, and the next load adopts it into Home (#354, #409, #404)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(1);
  const running = (await terminalCount(page)).before;

  // The pane close key: Cmd+Shift+W on macOS (herdr-app's), Ctrl+Shift+X elsewhere. The tab's only pane closes as its tab, and a space's last tab takes the
  // space with it, so it asks first, as herdr-app's space.close (#466 ruling D).
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+KeyW" : "Control+Shift+X");
  const ask = page.getByRole("dialog", { name: "Close space?" });
  await expect(ask).toContainText(/\u2014 1 tab, 1 terminal/);
  await ask.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("contentinfo")).toContainText(`${running - 1} terminal`, { timeout: 15_000 });
  await expect(tabs).toHaveCount(0);
  await expect(page.locator(`[data-terminal="${address}"]`)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A terminal started outside the app (or kept running by an older build) is in no tab: the emptied layout does not
  // show it alone (#354).
  const outside = startShell("host", "outside-any-tab");
  started.push(outside);
  await expect(page.getByRole("contentinfo")).toContainText(`${running} terminal`, { timeout: 15_000 });
  await expect(tabs).toHaveCount(0);

  // The next load adopts it as a tab of the space its space label names (startShell labels it api), so nothing is
  // hidden (#404, dc7760f); the closed shell is gone.
  await page.reload();
  await expect(page.getByRole("contentinfo")).toContainText(`${running} terminal`, { timeout: 20_000 });
  await expect(tabs).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(`[data-terminal="${outside}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(
    page
      .getByRole("complementary", { name: "Workspace" })
      .getByRole("region", { name: "Spaces" })
      .getByRole("button", { name: /^api\b/ }),
  ).toBeVisible();
});
