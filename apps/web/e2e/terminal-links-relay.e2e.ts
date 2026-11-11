import { pressNewTab } from "./fixtures.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { devices, expect, type Locator, type Page, test } from "@playwright/test";
import { routeRelaySockets } from "./relay-route.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";
import { commandModifier } from "./platform-keys.ts";

// A real hc reached through the private relay: the relay-host helper runs it under wrangler dev, so these specs need
// a relay checkout (DORIFACE_RELAY_DIR, as `bun run relay:fetch` makes) and are skipped without one.
test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
// Pairing over the relay, then a workspace and a shell reached through it, takes longer than a loopback test.
test.setTimeout(240_000);

interface Relayed {
  readonly relayUrl: string;
}

const HELPER = join(import.meta.dirname, "..", "..", "..", "tests", "relay", "support", "web-relay-host.ts");
let helper: ChildProcess | undefined;
let relayed: Relayed | undefined;

let reader: AsyncIterator<string> | undefined;

/** The next line the helper prints that starts with `prefix`, without the prefix; other lines are skipped. */
async function nextLine(prefix: string): Promise<string> {
  const next = await reader?.next();
  if (next === undefined || next.done === true) throw new Error(`relay-host ended before a ${prefix.trim()} line`);
  return next.value.startsWith(prefix) ? next.value.slice(prefix.length) : nextLine(prefix);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // Playwright sets FORCE_COLOR for its workers; wrangler would colour the line the helper waits for.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  const env = { ...inherited, NO_COLOR: "1" };
  helper = spawn("bun", [HELPER], { stdio: ["pipe", "pipe", "inherit"], env });
  if (helper.stdout === null) throw new Error("relay-host has no stdout");
  reader = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  relayed = JSON.parse(await nextLine("READY ")) as Relayed;
});

test.afterAll(async () => {
  const running = helper;
  if (running === undefined) return;
  running.kill("SIGTERM");
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 60_000 }).not.toBeNull();
});

/** Every href the page asked to open in a new tab; window.open is stubbed so a test never leaves the page. */
const opened = (page: Page): Promise<string[]> =>
  page.evaluate(() => (Reflect.get(window, "__opened") as string[] | undefined) ?? []);

/** Pairs this page with the relayed host by its link, as a person would, and opens a terminal on it over the relay. */
async function pairAndOpen(page: Page, newTab: (page: Page) => Locator): Promise<Locator> {
  if (relayed === undefined) throw new Error("no relayed host");
  // Pairing dials the link's relay; the workspace then dials the production one, as every release build does (#452).
  await routeRelaySockets(page, relayed.relayUrl);
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, "__opened", { value: seen });
    window.open = (url?: string | URL) => {
      seen.push(String(url));
      return null;
    };
  });
  helper?.stdin?.write("PAIR\n");
  await page.goto(`/pair${await nextLine("LINK ")}`);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByText("This device now reaches the host through the relay")).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click();
  // "+" opens the new-item menu since #548; pressNewTab picks its Terminal item (the phone header's starts one at once).
  await pressNewTab(newTab(page), { timeout: 60_000 });
  const terminal = page.locator("[data-terminal]").last();
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  return terminal;
}

/** Types a line into the shell, over the relay like any other input. */
async function run(page: Page, terminal: Locator, command: string): Promise<void> {
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** The page position of a column on the grid row whose text matches `text`. */
async function cellPoint(terminal: Locator, text: RegExp, col: number): Promise<{ x: number; y: number }> {
  const row = terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: text }).last();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const box = await row.boundingBox();
  const cell = await terminal.evaluate((element) =>
    parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width")),
  );
  if (box === null) throw new Error("the row has no box");
  return { x: box.x + (col + 0.5) * cell, y: box.y + box.height / 2 };
}

/** The key held for Cmd/Ctrl+click on the page's platform (#1309), not the runner's. */
const linkModifier = async (page: Page): Promise<"Meta" | "Control"> =>
  (await commandModifier(page)) === "super" ? "Meta" : "Control";
const OSC8 = (target: string, text: string) => String.raw`printf '\033]8;;${target}\033\\${text}\033]8;;\033\\\n'`;

/** A link to a scheme that may not open: Cmd/Ctrl+click names it in the menu, whose Open link is disabled. */
async function expectRefused(page: Page, terminal: Locator, target: string): Promise<void> {
  const text = `bad-${target.slice(0, 4)}`;
  await run(page, terminal, OSC8(target, text));
  const at = await cellPoint(terminal, new RegExp(`^${text}`), 1);
  const mod = await linkModifier(page);
  await page.keyboard.down(mod);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up(mod);
  const menu = page.getByRole("menu", { name: "Link" });
  await expect(menu).toContainText(`Does not open: ${target}`);
  await expect(menu.getByRole("menuitem", { name: "Open link" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

test("over the relay, Cmd/Ctrl+click opens plain and OSC 8 links, whole when wrapped, and never other schemes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const terminal = await pairAndOpen(page, (p) => p.getByRole("button", { name: "New tab", exact: true }));
  expect(page.url()).not.toContain("127.0.0.1:7799");
  const mod = await linkModifier(page);

  // A plain URL: a plain click does nothing, Cmd/Ctrl+click opens it.
  await run(page, terminal, "echo 'see https://example.com/plain-link now'");
  let at = await cellPoint(terminal, /^see https:\/\/example\.com\/plain-link now/, 10);
  await page.mouse.click(at.x, at.y);
  expect(await opened(page)).toEqual([]);
  await page.keyboard.down(mod);
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("[data-link-underline]")).toHaveCount(1);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up(mod);
  await expect.poll(() => opened(page)).toEqual(["https://example.com/plain-link"]);

  // A URL longer than a row wraps: clicking its second row opens it whole.
  const cols = await terminal.evaluate((element) => element.querySelector(".term-row")?.textContent?.length ?? 0);
  const long = `https://example.com/${"w".repeat(cols)}/end`;
  await run(page, terminal, `echo ${long}`);
  at = await cellPoint(terminal, /^w*\/end/, 1);
  await page.keyboard.down(mod);
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("[data-link-underline]")).toHaveCount(2);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up(mod);
  await expect.poll(() => opened(page)).toEqual(["https://example.com/plain-link", long]);

  // An OSC 8 link whose text is not its target: the target shows, on hover and in the menu, before anything opens.
  await run(page, terminal, OSC8("https://example.org/real-target", "the docs"));
  at = await cellPoint(terminal, /^the docs/, 2);
  await page.keyboard.down(mod);
  await page.mouse.move(at.x, at.y);
  await expect(page.getByRole("tooltip").filter({ hasText: "https://example.org/real-target" })).toBeVisible();
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up(mod);
  const menu = page.getByRole("menu", { name: "Link" });
  await expect(menu).toContainText("https://example.org/real-target");
  expect(await opened(page)).toHaveLength(2);
  await menu.getByRole("menuitem", { name: "Open link" }).click();
  await expect
    .poll(() => opened(page))
    .toEqual(["https://example.com/plain-link", long, "https://example.org/real-target"]);

  // javascript: and file: links never open: the menu names what they are and offers no way to open them.
  await expectRefused(page, terminal, "javascript:alert(1)");
  await expectRefused(page, terminal, "file:///etc/passwd");
  expect(await opened(page)).toHaveLength(3);
});

test.describe("on a phone", () => {
  const { defaultBrowserType: _browser, ...iphone } = devices["iPhone 14"];
  test.use({ ...iphone, viewport: { width: 390, height: 844 } });

  test("over the relay, a tap on a link offers Open link and Copy link", async ({ page }) => {
    const terminal = await pairAndOpen(page, (p) => p.getByRole("banner").getByRole("button", { name: "New tab" }));
    await run(page, terminal, "echo https://example.com/tapped");
    const at = await cellPoint(terminal, /^https:\/\/example\.com\/tapped/, 3);
    await page.touchscreen.tap(at.x, at.y);
    const menu = page.getByRole("menu", { name: "Link" });
    await expect(menu).toContainText("https://example.com/tapped");
    await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Open link" }).click();
    await expect.poll(() => opened(page)).toEqual(["https://example.com/tapped"]);
  });
});
