import type { Locator, Page } from "@playwright/test";
import { coreSize, gridSize } from "./core-size.ts";
import { expect, openNewTerminal, openNewTerminalBehindLatency, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { endOwnTerminals } from "./own-terminals.ts";

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

test("an unfocused split pane keeps its pty size through a reattach until it is focused, then takes its grid's", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  const single = await gridSize(focused);
  // Split right focuses the new pane, so the first one is the unfocused pane.
  await page.getByRole("button", { name: "Split right" }).click();
  const unfocused = page.locator('[data-focused="false"] [data-terminal]:visible');
  await expect(unfocused).toHaveCount(1);
  const address = (await unfocused.getAttribute("data-terminal")) ?? "";
  // The pane starts at the single-pane width; read its size once the split has laid it out and the core has it.
  await expect.poll(() => gridSize(unfocused)).not.toBe(single);
  await expect.poll(async () => coreSize(address) === (await gridSize(unfocused)), { timeout: 15_000 }).toBe(true);
  const before = coreSize(address);

  const opened = link.opened();
  await link.drop(true);
  // The status bar says the link is down. Each pane also says Reconnecting while it re-attaches, so two panes say it at once.
  const reconnecting = page.getByRole("status").filter({ hasText: "Reconnecting" });
  await expect(page.getByRole("contentinfo").getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 600 });
  await expect.poll(() => gridSize(unfocused)).not.toBe(before);
  link.restore();
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect(reconnecting).toHaveCount(0, { timeout: 15_000 });

  // resumed: true defers a background viewer's size, so another device in use keeps its own; the pane in use applies.
  const focusedAddress = (await focused.getAttribute("data-terminal")) ?? "";
  await expect.poll(() => coreSize(focusedAddress), { timeout: 10_000 }).toBe(await gridSize(focused));
  expect(coreSize(address)).toBe(before);
  // Focusing the pane (no key pressed) makes it the active viewer, and its size applies.
  await unfocused.getByRole("textbox").focus();
  await expect.poll(() => coreSize(address), { timeout: 10_000 }).toBe(await gridSize(unfocused));
});
