import type { Locator, Page } from "@playwright/test";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, openNewTerminal, openNewTerminalBehindLatency, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { secondDevice } from "./second-device.ts";

endOwnTerminals();

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

// Over the relay the attach reply arrives after the view has fitted its grid; loopback is too fast to show that.
const RELAY_LATENCY_MS = 300;

let queries = 0;

/** The size the shell's pty reports and the grid the view renders, both as "rows cols". */
async function sizes(page: Page, terminal: Locator): Promise<{ readonly pty: string; readonly view: string }> {
  // Each query has its own tag: under latency the previous reply is still on screen when the next one is typed.
  queries += 1;
  const tag = `pty${queries}`;
  await terminal.getByRole("textbox").focus();
  // One input event, the way wterm takes a commit: typed key by key, the query alone took seconds on a loaded host.
  await page.keyboard.insertText(`clear; echo "${tag} $(stty size)"`);
  await page.keyboard.press("Enter");
  const replyText = new RegExp(String.raw`^${tag} \d+ \d+\s*$`);
  const reply = terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: replyText });
  await expect(reply).toHaveCount(1, { timeout: 15_000 });
  const pty = ((await reply.textContent()) ?? "").trim().slice(tag.length + 1);
  return { pty, view: await gridSize(terminal) };
}

test("a new terminal's pty has the size of the grid it renders", async ({ page }) => {
  const { terminal } = await openNewTerminalBehindLatency(page, RELAY_LATENCY_MS);
  const { pty, view } = await sizes(page, terminal);
  expect(pty).toBe(view);
});

test("a terminal re-attached after the link reconnects has the size of the grid it renders", async ({ page }) => {
  const { terminal, link } = await openNewTerminalBehindLatency(page, RELAY_LATENCY_MS);
  const opened = link.opened();
  await link.drop(false);
  // The terminal stays on screen while the link is down and is attached again once the page has reconnected.
  await expect(terminal).toBeVisible();
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeHidden({ timeout: 15_000 });
  const { pty, view } = await sizes(page, terminal);
  expect(pty).toBe(view);
});

test("the pty follows the grid when the window resizes", async ({ page }) => {
  const { terminal } = await openNewTerminalBehindLatency(page, RELAY_LATENCY_MS);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const before = await gridSize(terminal);
  await page.setViewportSize({ width: 900, height: 600 });
  // The resize has settled once the view shows a new grid and the core holds that size. Both are read without typing:
  // a typed query takes a shell round trip, longer than a poll's whole budget on a loaded host.
  await expect
    .poll(async () => {
      const view = await gridSize(terminal);
      return view !== before && coreSize(address) === view;
    })
    .toBe(true);
  const { pty, view } = await sizes(page, terminal);
  expect(pty).toBe(view);
});

test("the pty follows the grid when the device pixel ratio changes", async ({ page }) => {
  const { terminal } = await openNewTerminalBehindLatency(page, RELAY_LATENCY_MS);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("the page has no viewport");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1.75, mobile: false });
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(1.75);
  const { pty, view } = await sizes(page, terminal);
  expect(pty).toBe(view);
});

test("a terminal resized while the link is down has its grid's pty size after the reattach, with no key pressed", async ({
  page,
}) => {
  const { terminal, link } = await openNewTerminalBehindLatency(page, RELAY_LATENCY_MS);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await expect.poll(() => coreSize(address), { timeout: 15_000 }).toBe(await gridSize(terminal));
  const opened = link.opened();
  await link.drop(true);
  const reconnecting = page.getByRole("status").filter({ hasText: "Reconnecting" });
  await expect(reconnecting).toBeVisible();
  const before = await gridSize(terminal);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect.poll(() => gridSize(terminal)).not.toBe(before);

  link.restore();
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect(reconnecting).toBeHidden({ timeout: 15_000 });
  // Read from the core, so nothing typed can make this viewer active and apply the size for it.
  await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(await gridSize(terminal));
});

/** Opens a terminal and splits it: the new pane takes focus, and the first one is left unfocused at its split size. */
async function splitWithUnfocusedPane(page: Page): Promise<{ readonly focused: Locator; readonly unfocused: Locator }> {
  await openNewTerminal(page);
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  const single = await gridSize(focused);
  await page.getByRole("button", { name: "Split right" }).click();
  const unfocused = page.locator('[data-focused="false"] [data-terminal]:visible');
  await expect(unfocused).toHaveCount(1);
  const address = (await unfocused.getAttribute("data-terminal")) ?? "";
  // The pane starts at the single-pane width; it is ready once the split has laid it out and the core has that size.
  await expect.poll(() => gridSize(unfocused)).not.toBe(single);
  await expect.poll(async () => coreSize(address) === (await gridSize(unfocused)), { timeout: 15_000 }).toBe(true);
  return { focused, unfocused };
}

/**
 * The link drops, the window is resized while it is down, and the page reconnects: each pane attaches again with
 * `resumed: true` and the grid it has now. Resolves once the focused pane's size is the core's: its FOCUS has made it the
 * active viewer, so the page's reattach has been answered.
 */
async function blipWithResize(page: Page, link: HcSocket, focused: Locator, unfocused: Locator): Promise<void> {
  const before = await gridSize(unfocused);
  const opened = link.opened();
  await link.drop(true);
  const reconnecting = page.getByRole("status").filter({ hasText: "Reconnecting" });
  await expect(reconnecting).toBeVisible();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect.poll(() => gridSize(unfocused)).not.toBe(before);
  link.restore();
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect(reconnecting).toBeHidden({ timeout: 15_000 });
  const focusedAddress = (await focused.getAttribute("data-terminal")) ?? "";
  await expect.poll(() => coreSize(focusedAddress), { timeout: 10_000 }).toBe(await gridSize(focused));
}

// A reattach after a blip says `resumed: true`: the core gives that viewer the pty only while no other viewer is more
// recently active (herdr-core viewers.rs `apply_size`), so another device in use keeps its size (0870d841, #75). With
// nobody else on the terminal, the pane the page draws is the only viewer, and its own grid sizes the pty (#2390).
test("an unfocused split pane resized while the link was down has its grid's pty size after the reattach, with nothing focused or typed", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const { focused, unfocused } = await splitWithUnfocusedPane(page);
  const address = (await unfocused.getAttribute("data-terminal")) ?? "";
  await blipWithResize(page, link, focused, unfocused);
  await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(await gridSize(unfocused));
  await expect(unfocused).toHaveAttribute("data-terminal", address);
});

test("an unfocused split pane another device is using keeps that device's pty size through a reattach until it is focused, then takes its grid's", async ({
  page,
  browser,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const { focused, unfocused } = await splitWithUnfocusedPane(page);
  const address = (await unfocused.getAttribute("data-terminal")) ?? "";
  // Another desk, a different window size, shows the same layout; focusing the pane there makes it the active viewer.
  const other = await secondDevice(browser, { width: 1200, height: 480 });
  try {
    await other.goto("/");
    const there = other.locator(`[data-terminal="${address}"]`);
    await expect(there).toBeVisible({ timeout: 20_000 });
    await there.getByRole("textbox").focus();
    const theirs = await gridSize(there);
    await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(theirs);

    await blipWithResize(page, link, focused, unfocused);
    expect(await gridSize(unfocused)).not.toBe(theirs);
    expect(coreSize(address)).toBe(theirs);
    // Focusing the pane here (no key pressed) makes this page its active viewer, and its size applies.
    await unfocused.getByRole("textbox").focus();
    await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(await gridSize(unfocused));
  } finally {
    await other.context().close();
  }
});
