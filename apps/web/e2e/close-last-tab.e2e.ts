import { startShell } from "./agents.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) hcOn("host", ["kill", address]);
});

test("closing the only tab asks Close space?, ends its shell and empties the workspace; a terminal started outside the app is adopted into its space without a reload, and a reload adopts nothing twice (#354, #409, #404, #2122)", async ({
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
  await pressShortcut(page, "pane.close");
  const ask = page.getByRole("dialog", { name: "Close space?" });
  await expect(ask).toContainText(/\u2014 1 tab, 1 terminal/);
  await ask.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("contentinfo")).toContainText(`${running - 1} terminal`, { timeout: 15_000 });
  await expect(tabs).toHaveCount(0);
  await expect(page.locator(`[data-terminal="${address}"]`)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A terminal started outside the app is in no tab at first. A few seconds after it starts, without a reload, it is
  // adopted as a tab of the space its space label names (startShell labels it api), so nothing is hidden (#404, #2122);
  // the closed shell is gone.
  const outside = startShell("host", "outside-any-tab");
  started.push(outside);
  await expect(page.getByRole("contentinfo")).toContainText(`${running} terminal`, { timeout: 15_000 });
  await expect(tabs).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(`[data-terminal="${outside}"]`)).toBeVisible({ timeout: 15_000 });
  const api = page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: /^api\b/ });
  await expect(api).toBeVisible();

  // A reload finds it in its tab and adopts nothing twice.
  await page.reload();
  await expect(page.getByRole("contentinfo")).toContainText(`${running} terminal`, { timeout: 20_000 });
  await expect(page.locator(`[data-terminal="${outside}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(tabs).toHaveCount(1);
  await expect(api).toHaveCount(1);
});
