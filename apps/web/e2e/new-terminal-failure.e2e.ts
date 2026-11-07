import { expect, openNewTerminal, test, pressNewTab } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

test("a New tab that fails says so with the sidebar hidden, where the machine list cannot show it", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeHidden();
  await socket.drop(true);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await expect(page.getByRole("heading", { name: "Could not open a new tab" })).toHaveCount(1);
  await expect(page.getByText(/try again once it is back/)).toBeVisible();
  // One act of the person asks the core at most once: a second terminal.run here would be a dispatch reaching the handler
  // twice, and it would report the same failure twice (#1343).
  const asked = socket.sent().filter((frame) => frame.includes("terminal.run")).length;
  expect(asked, "one New tab asks the core at most once").toBeLessThanOrEqual(1);
  socket.restore();
});

test("New terminal on an added machine that fails reports in the same place as New tab", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const machines = page.getByRole("region", { name: "Spaces" });
  const newOn = machines.getByRole("button", { name: /^New space on build-box/ });
  // An earlier spec may have taken the machine offline; it is back once its button is enabled again.
  await expect(newOn).toBeEnabled({ timeout: 30_000 });
  // Hold the core's reply, so the link drops while the run is in flight and the run fails.
  socket.delay(60_000);
  await newOn.click();
  await socket.drop(true);
  await expect(page.getByText("Could not open a new tab")).toBeVisible();
  await expect(machines.getByText(/No new terminal on/)).toHaveCount(0);
  socket.restore();
});
