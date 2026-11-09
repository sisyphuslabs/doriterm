import { endAgent, startShell } from "./agents.ts";
import { E2E_HOST_PORT } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { clearLayout, seedLayout } from "./layout-doc.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("while the saved layout loads, the desktop says so instead of 'No terminal open' (#482)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";

  const release = socket.hold("doc.get", "machine.list");
  await page.reload();
  // The core has listed its terminals (the status bar counts the open one) while the layout is still unanswered.
  await expect(page.getByText(/^1 terminal$/)).toBeVisible();
  await expect(page.getByRole("status", { name: "Restoring your tabs" })).toBeVisible();
  await expect(page.getByText("No terminal open")).toHaveCount(0);

  release();
  await expect(page.locator(`[data-terminal="${address}"]`)).toBeVisible();
  await expect(page.getByRole("status", { name: "Restoring your tabs" })).toHaveCount(0);
  await expect(page.getByText("No terminal open")).toHaveCount(0);
});

test("a terminal waiting on its attach says it is opening, and the pane is busy until it attaches (#483)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";

  const release = socket.hold("terminal.attach");
  await page.reload();
  const pane = page.locator(`[data-terminal="${address}"]`);
  await expect(pane).toBeVisible();
  const opening = page.getByRole("status", { name: "Opening terminal" });
  await expect(opening).toBeVisible();
  await expect(pane.locator("xpath=..")).toHaveAttribute("aria-busy", "true");
  const before = await pane.boundingBox();

  release();
  await expect(opening).toHaveCount(0);
  await expect(pane.locator("xpath=..")).not.toHaveAttribute("aria-busy", "true");
  await expect(pane).toContainText("$");
  // The opening state sat over the grid: the terminal kept its size when it went away.
  expect(await pane.boundingBox()).toEqual(before);
});

test.describe("loading feedback waits before it spins (#1498)", () => {
  const started: string[] = [];

  test.afterEach(() => {
    clearLayout();
    for (const address of started.splice(0)) endAgent("host", address);
  });

  test("a terminal that is still opening says so at once and shows a spinner only after a second", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const socket = await routeHcSocket(page);
    await page.goto("/");
    // Fake time starts once the workspace is on screen; the tab this watcher opens arrives by the host's own document.
    await expect(page.getByRole("button", { name: "New tab" })).toBeVisible({ timeout: 20_000 });
    await page.clock.install();
    // A margin keeps the jump off the past when the page's clock ticks ahead of the runner's between the two calls.
    await page.clock.pauseAt(new Date(Date.now() + 1_000));

    const address = startShell("host", "load-opening");
    started.push(address);
    const release = socket.hold("terminal.attach");
    seedLayout([{ id: "tb-load-open", root: [{ pane: "p-load-open", terminal: address }] }]);

    const opening = page.getByRole("status", { name: "Opening terminal" });
    await expect(opening).toBeVisible({ timeout: 20_000 });
    // Painted from the first frame: a wait never opens as a blank area and then appears.
    await expect(opening).toHaveCSS("opacity", "1");
    const text = opening.getByText("Opening…");
    // The wait names what it waits for at once; the spinner is held back, and its box with it so no layout moves.
    await expect(text).toBeVisible();
    const resting = await text.boundingBox();
    await page.clock.runFor(500);
    await expect(opening.locator('[data-slot="spinner"]')).toHaveCount(0);
    await page.clock.runFor(500);
    await expect(opening.locator('[data-slot="spinner"]')).toBeVisible();
    expect(await text.boundingBox()).toEqual(resting);

    release();
    await expect(opening).toHaveCount(0, { timeout: 20_000 });
  });

  test("a connect that stays unanswered names the session at once and shows a spinner only after a second", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // A socket that never opens holds the screen in its connecting state long enough to watch the wait itself.
    await page.routeWebSocket(`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, () => {});
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.goto("/");

    const title = page.getByText("Connecting to your host");
    await expect(title).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Opening the session.")).toBeVisible();
    await expect(page.locator('[data-slot="spinner"]')).toHaveCount(0);
    const resting = await title.boundingBox();
    await page.clock.runFor(500);
    await expect(page.locator('[data-slot="spinner"]')).toHaveCount(0);
    await page.clock.runFor(500);
    await expect(page.locator('[data-slot="spinner"]')).toBeVisible();
    // The icon's box was kept while it waited, so the words did not move when it arrived.
    expect(await title.boundingBox()).toEqual(resting);
  });

  test("while the workspace's code loads, a status fills the screen instead of leaving it blank", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await routeHcSocket(page);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    await page.route(/\/assets\/workspace-[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/");

    const loading = page.getByRole("status", { name: "Loading the workspace" });
    await expect(loading).toBeVisible({ timeout: 20_000 });
    const box = await loading.boundingBox();
    expect(box).toMatchObject({ width: 1440, height: 900 });

    release();
    await expect(loading).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "New tab" })).toBeVisible({ timeout: 20_000 });
  });
});
