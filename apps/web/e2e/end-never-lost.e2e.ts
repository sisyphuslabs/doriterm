import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";
import { tabOf } from "./tab-strip.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

function hc(...args: string[]): string {
  const { hc: bin, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(bin, args, { env: { ...process.env, ...env }, encoding: "utf8" });
}

/** Whether the core still holds this terminal, finished ones included. */
function onCore(address: string): boolean {
  const listed: unknown = JSON.parse(hc("ls", "--all", "--json"));
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminal list");
  return terminals.some((terminal) => JSON.stringify(terminal).includes(`"${address}"`));
}

// By tag, not role: an open dialog marks the page behind it aria-hidden, which a role query would read as absent.
const agentsList = (page: Page) => page.locator("h1", { hasText: /^Agents$/ });
const sent = (link: HcSocket, method: string): boolean =>
  link.sent().some((frame) => frame.includes(`"method":"${method}"`));

/** A phone-sized page on a new terminal named `name-<address>`, its terminal screen open. */
async function phoneOnTerminal(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  const link = await routeHcSocket(page);
  await page.goto("/");
  await expect(agentsList(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("the new terminal has no address");
  const named = `${name}-${address}`;
  hc("label", address, `herdr.name=${named}`);
  // The header reads the tab (#466 ruling A); the session actions name the session shown.
  await expect(
    page.getByRole("banner").getByRole("button", { name: `Session actions for ${named}`, exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  return { link, name: named, address };
}

/** Asks End from the phone header and confirms it, with these End calls held on the way to the core. */
async function confirmEndHolding(page: Page, link: HcSocket, name: string, ...methods: string[]): Promise<() => void> {
  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Session actions for / })
    .click();
  await page.getByRole("button", { name: "End session…", exact: true }).click();
  const deliver = link.hold(...methods);
  await page
    .getByRole("dialog", { name: `End ${name}?` })
    .getByRole("button", { name: "End session" })
    .click();
  await expect.poll(() => methods.every((method) => sent(link, method))).toBe(true);
  return deliver;
}

test("an End whose removal is held still removes the terminal when the user goes back and the page closes", async ({
  page,
}) => {
  const { link, name, address } = await phoneOnTerminal(page, "end-back-close");
  await confirmEndHolding(page, link, name, "terminal.rm");
  const ask = page.getByRole("dialog", { name: `End ${name}?` });
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  // Back to the list, or there already: the screen leaves by itself once the session is gone.
  const back = page.getByRole("button", { name: "Back to agents" });
  if ((await back.count()) > 0) await back.click();
  await expect(agentsList(page)).toBeVisible();
  await page.close();
  await expect.poll(() => onCore(address), { timeout: 15_000, message: `${address} still on the core` }).toBe(false);
});

test("an End whose calls never left the page before it closed is finished by the next page", async ({ page }) => {
  const { link, name, address } = await phoneOnTerminal(page, "end-unsent");
  // Uplink stalled: End's mark and kill are out of the page's hands but not on the wire to the core, and the page closes.
  await confirmEndHolding(page, link, name, "terminal.label", "terminal.kill");
  const context = page.context();
  await page.close();
  expect(onCore(address)).toBe(true);

  const next = await context.newPage();
  await next.setViewportSize({ width: 390, height: 844 });
  await next.goto("/");
  await expect(agentsList(next)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => onCore(address), { timeout: 15_000, message: `${address} still on the core` }).toBe(false);
});

test("a stalled End says it did not end once its calls time out, and a second End finishes it", async ({ page }) => {
  test.setTimeout(120_000);
  const { link, name, address } = await phoneOnTerminal(page, "end-stalled");
  // The uplink stalls while the core's heartbeats keep arriving, so the link never reads as silent.
  await confirmEndHolding(page, link, name, "terminal.label", "terminal.kill");
  const ask = page.getByRole("dialog", { name: `End ${name}?` });
  await expect(ask.getByRole("alert")).toContainText("The session did not end", { timeout: 45_000 });
  expect(onCore(address)).toBe(true);

  // The stalled link goes away with its unsent calls, and the page reconnects on a new one that carries calls again.
  const opened = link.opened();
  await link.drop(false);
  link.hold();
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(opened);
  await expect(page.locator('[role="status"]', { hasText: /Reconnecting|Offline/ })).toHaveCount(0, {
    timeout: 15_000,
  });
  await ask.getByRole("button", { name: "End session" }).click();
  await expect(ask).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => onCore(address), { timeout: 15_000, message: `${address} still on the core` }).toBe(false);
});

/** Two named terminals on the desktop; the second one's tab selected. */
async function twoTabs(page: Page, prefix: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const link = await routeHcSocket(page);
  await page.goto("/");
  const named = async (which: string) => {
    const terminal = await openNewTerminal(page);
    const address = (await terminal.getAttribute("data-terminal")) ?? "";
    const name = `${prefix}-${which}-${address}`;
    hc("label", address, `herdr.name=${name}`);
    // A tab reads its number, as herdr-app's; the session's name shows on its actions.
    await expect(page.getByRole("button", { name: `Session actions for ${name}` })).toBeVisible({ timeout: 15_000 });
    addressOf.set(name, address);
    return { name, address };
  };
  const first = await named("a");
  const second = await named("b");
  return { link, a: first.name, b: second.name, addressOfA: first.address };
}

/** Each named terminal's address, to find its tab, which reads its number rather than the session's name. */
const addressOf = new Map<string, string>();

async function endFromStrip(page: Page, name: string): Promise<void> {
  await (await tabOf(page, addressOf.get(name) ?? "")).click();
  await page.getByRole("button", { name: `Session actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "End session…" }).click();
}

async function renameFromStrip(page: Page, name: string) {
  await (await tabOf(page, addressOf.get(name) ?? "")).click();
  await page.getByRole("button", { name: `Session actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const rename = page.getByRole("dialog", { name: /^Rename / });
  await expect(rename).toBeVisible();
  return rename;
}

test("an End left with Cancel that later succeeds does not close another session's question", async ({ page }) => {
  const { link, a, b, addressOfA } = await twoTabs(page, "end-late-ok");
  await endFromStrip(page, a);
  const deliver = link.hold("terminal.label", "terminal.kill");
  const ask = page.getByRole("dialog", { name: `End ${a}?` });
  await ask.getByRole("button", { name: "End session" }).click();
  await expect.poll(() => sent(link, "terminal.kill")).toBe(true);
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);

  const rename = await renameFromStrip(page, b);
  deliver();
  await expect.poll(() => onCore(addressOfA), { timeout: 15_000 }).toBe(false);
  await expect(page.locator(`[role="tabpanel"] [data-terminal="${addressOfA}"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect(rename).toBeVisible();
  await expect(rename.getByRole("textbox", { name: "Name" })).toBeEditable();
});

test("an End left with Cancel that later fails does not put its error in another session's question", async ({
  page,
}) => {
  const { link, a, b } = await twoTabs(page, "end-late-fail");
  await endFromStrip(page, a);
  link.hold("terminal.label", "terminal.kill");
  const ask = page.getByRole("dialog", { name: `End ${a}?` });
  await ask.getByRole("button", { name: "End session" }).click();
  await expect.poll(() => sent(link, "terminal.kill")).toBe(true);
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);

  const rename = await renameFromStrip(page, b);
  // The link drops with A's End unanswered: that End fails, after its question is gone.
  await link.drop(false);
  await expect(page.locator('[role="status"]', { hasText: /Reconnecting|Offline/ })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(rename).toBeVisible();
  await expect(rename.getByRole("alert")).toHaveCount(0);
  await expect(rename.getByText("relay blip")).toHaveCount(0);
});
