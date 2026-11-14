import { expect, openNewTerminal, terminalCount, test, pressNewTab } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow, newOn as newSpaceOn, reconnect, STATE_BOUND_MS, switchTo } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

test("a delayed New terminal refusal uses the row's reconnect grace (#2600 M1)", async ({ page }, testInfo) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await expect(newSpaceOn(page)).toBeEnabled({ timeout: 30_000 });
  const release = socket.hold("terminal.run");
  try {
    await newSpaceOn(page).click();
    await expect.poll(() => socket.sent().some((frame) => frame.includes('"method":"terminal.run"'))).toBe(true);
    switchTo("drop");
    await expect(machineRow(page)).toContainText("reconnecting", { timeout: STATE_BOUND_MS });
    release();
    const notice = page.getByRole("heading", { name: "Could not open a new tab" });
    await expect(notice).toBeVisible();
    await expect(notice.locator("..")).toContainText(`${MACHINE_NAME} is reconnecting`);
    await notice.hover();
    await page.screenshot({ path: testInfo.outputPath("refusal-reconnecting-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("refusal-reconnecting-phone.png") });
  } finally {
    release();
    reconnect();
  }
});

test("a New tab that fails says so with the sidebar hidden, where the machine list cannot show it", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeHidden();
  // New tab is pressed while the link is up (while it is down it is offered disabled, #2455); the link answers late and
  // drops with the run in flight, so the run fails.
  socket.delay(60_000);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await socket.drop(true);
  const notice = page.getByRole("heading", { name: "Could not open a new tab" });
  await expect(notice).toHaveCount(1);
  await expect(page.getByText(/try again once it is back/)).toBeVisible();
  // A duplicate that renders later in this step is caught here; one that renders after it is not, so this narrows the
  // window rather than closing it (#1343).
  await expect(notice).toHaveCount(1);
  socket.delay(0);
  socket.restore();
});

test("one New tab asks the core once, so a failure has one cause to report", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const asked = (): number => socket.sent().filter((frame) => frame.includes("terminal.run")).length;
  const before = asked();
  // The link answers late, so the ask stays on the wire while the run is in flight: a second dispatch is recorded here,
  // where a press made after the drop could not be (#1343).
  socket.delay(60_000);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await expect.poll(asked, { message: "one New tab asks the core" }).toBe(before + 1);
  await socket.drop(true);
  await expect(page.getByRole("heading", { name: "Could not open a new tab" })).toHaveCount(1);
  expect(asked(), "one New tab asks the core once, not twice").toBe(before + 1);
  socket.delay(0);
  socket.restore();
});

test("a New tab whose answer the link lost still opened, so it reports nothing, and New tab waits disabled while down", async ({
  page,
}) => {
  // The run reaches the core and the feed lists its terminal before its answer does, as on a busy host. Its answer is
  // held here, so the tab opens first and the link drops before the answer lands: the press did open a tab, so its lost
  // answer is no failure to report (#1343). While the link is down New tab cannot start a terminal, so it is offered
  // disabled rather than pressed and refused (#2455), and it comes back with the link.
  let asked: string | undefined;
  let answer: (() => void) | undefined;
  const socket = await routeHcSocket(page, {
    sent: (frame) => {
      if (asked !== undefined || !frame.includes('"method":"terminal.run"')) return;
      const id = /"id":(\d+)/.exec(frame)?.[1];
      if (id === undefined) return;
      asked = id;
      answer = socket.holdFromHost(`"id":${id},`);
    },
  });
  await page.goto("/");
  const count = await terminalCount(page);
  await pressNewTab(page.getByRole("button", { name: "New tab", exact: true }));
  await count.grown();
  // The terminal is live, and the first-live rule opened its tab, without the run's answer.
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toHaveAttribute("data-terminal", /./, {
    timeout: 15_000,
  });
  const newTab = page.getByRole("button", { name: "New tab", exact: true });
  await socket.drop(true);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  await expect(newTab).toBeDisabled();
  answer?.();
  socket.restore();
  // Back on the link, New tab is offered again; the lost answer, settled at the drop, left no notice behind.
  await expect(newTab).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Could not open a new tab" })).toHaveCount(0);
});

test("New terminal on an added machine that fails reports in the same place as New tab", async ({ page }) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const machines = page.getByRole("region", { name: "Spaces" });
  const newOn = machines.getByRole("button", { name: /^New space on build-box/ });
  // An earlier spec may have taken the machine offline; it is back once its button is enabled again.
  await expect(newOn).toBeEnabled({ timeout: 30_000 });
  // Keep the run before the core: losing only its reply can leave a successfully started remote terminal behind.
  const before = socket.sent().filter((frame) => frame.includes('"method":"terminal.run"')).length;
  socket.hold("terminal.run");
  await newOn.click();
  await expect
    .poll(() => socket.sent().filter((frame) => frame.includes('"method":"terminal.run"')).length)
    .toBe(before + 1);
  await socket.drop(true);
  await expect(page.getByText("Could not open a new tab")).toBeVisible();
  await expect(machines.getByText(/No new terminal on/)).toHaveCount(0);
  socket.restore();
});
