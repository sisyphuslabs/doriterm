import { startShell } from "./agents.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { holdRunAnswer } from "./run-answer.ts";
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
  const link = await routeHcSocket(page);
  await page.goto("/");
  // The run's answer is held while the terminal opens, as a loaded host is slow to give it (#2911, #2913). The terminal
  // is listed and shown before that answer, but only the answer places its tab in a space. Layout writes are held too,
  // which keeps adoption's (shown once saved) off the screen however slow the host: the close key is pressed while the
  // tab is still the terminal shown alone, in no space, and the close waits for that tab to be placed.
  const answering = holdRunAnswer(link);
  const writing = link.hold("doc.set");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(1);
  const running = (await terminalCount(page)).before;

  // The pane close key: Cmd+Shift+W on macOS (herdr-app's), Ctrl+Shift+X elsewhere. The tab's only pane closes as its tab, and a space's last tab takes the
  // space with it, so it asks first, as herdr-app's space.close (#466 ruling D).
  await pressShortcut(page, "pane.close");
  // The close is taken and waits for the tab to be placed: the tab's close button says so.
  await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("button", { name: /^Close / })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  answering();
  writing();
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

test("a close pressed while an adoption of the unplaced terminal is being written still asks Close space? once it is placed (#2913)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const link = await routeHcSocket(page);
  await page.goto("/");
  // As on a host slower than adoption's grace: the run's answer is held past it, so adoption writes the terminal a tab
  // (held, shown once saved) before the close key is pressed; the run's own placement is then written behind it.
  const answering = holdRunAnswer(link);
  const writing = link.hold("doc.set");
  await openNewTerminal(page);
  const running = (await terminalCount(page)).before;
  await expect
    .poll(() => link.sent().some((frame) => frame.includes('"method":"doc.set"')), { timeout: 20_000 })
    .toBe(true);
  await pressShortcut(page, "pane.close");
  answering();
  writing();
  const ask = page.getByRole("dialog", { name: "Close space?" });
  await expect(ask).toContainText(/\u2014 1 tab, 1 terminal/);
  await ask.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("contentinfo")).toContainText(`${running - 1} terminal`, { timeout: 15_000 });
  await expect(page.getByRole("tab")).toHaveCount(0);
});
