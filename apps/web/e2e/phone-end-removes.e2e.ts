import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

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

/** The core's view of one terminal: its state, why it finished, and whether it carries End's mark. */
function terminalOf(address: string) {
  const shown: unknown = JSON.parse(hc("get", address, "--json"));
  if (typeof shown !== "object" || shown === null) throw new Error(`hc get ${address} printed no terminal`);
  const labels: unknown = Reflect.get(shown, "labels");
  return {
    state: Reflect.get(shown, "state"),
    reason: Reflect.get(shown, "reason"),
    marked: typeof labels === "object" && labels !== null && Object.hasOwn(labels, "herdr.end"),
  };
}

/** A terminal started with hc, outside the page; returns its address. */
function hcRun(...argv: string[]): string {
  const started: unknown = JSON.parse(hc("run", "--bg", "--json", "--", ...argv));
  const address = typeof started === "object" && started !== null ? Reflect.get(started, "address") : undefined;
  if (typeof address !== "string") throw new Error("hc run printed no address");
  return address;
}

// By tag, not role: an open dialog marks the page behind it aria-hidden, which a role query would read as absent.
const agentsList = (page: Page) => page.locator("h1", { hasText: /^Agents$/ });
/** The open session: the header reads its tab (#466 ruling A), so the session is named by its own actions button. */
const screenOf = (page: Page, name: string) =>
  page.getByRole("banner").getByRole("button", { name: `Session actions for ${name}`, exact: true });

/** On the phone page: opens `name`, asks End, and has these calls of it leave the page but not reach the core yet. */
async function endHolding(phone: Page, link: HcSocket, name: string, ...methods: string[]): Promise<() => void> {
  await phone.getByText(name).first().click();
  await expect(screenOf(phone, name)).toBeVisible();
  await phone
    .getByRole("banner")
    .getByRole("button", { name: /^Session actions for / })
    .click();
  await phone.getByRole("button", { name: "End session…", exact: true }).click();
  const deliver = link.hold(...methods);
  await phone
    .getByRole("dialog", { name: `End ${name}?` })
    .getByRole("button", { name: "End session" })
    .click();
  const out = (method: string): boolean => link.sent().some((frame) => frame.includes(`"method":"${method}"`));
  await expect.poll(() => methods.every(out)).toBe(true);
  return deliver;
}

/** A phone-sized page with a new terminal named `name-<address>`; returns the page's link, the name and the address. */
async function phoneWithTerminal(page: Page, name: string) {
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
  await page.getByRole("button", { name: "Back to agents" }).click();
  await expect(page.getByText(named).first()).toBeVisible({ timeout: 15_000 });
  return { link, name: named, address };
}

test("a session ended on a phone is removed even when the page closes as soon as the list shows", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("the new terminal has no address");
  const name = `end-on-phone-${address}`;
  hc("label", address, `herdr.name=${name}`);
  // A tab reads its number, as herdr-app's; the session's name shows on its actions.
  await expect(page.getByRole("button", { name: `Session actions for ${name}` })).toBeVisible({ timeout: 15_000 });

  // The phone: a second page of the same browser, narrow, so it shows the phone navigation.
  const phone = await page.context().newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  const link = await routeHcSocket(phone);
  await phone.goto("/");
  await expect(agentsList(phone)).toBeVisible({ timeout: 20_000 });
  await endHolding(phone, link, name);
  await expect(phone.getByRole("dialog", { name: `End ${name}?` })).toHaveCount(0, { timeout: 15_000 });
  await expect(agentsList(phone)).toBeVisible({ timeout: 15_000 });
  await phone.close();

  await expect.poll(() => onCore(address), { timeout: 10_000, message: `${address} still on the core` }).toBe(false);
  await expect(page.locator(`[role="tabpanel"] [data-terminal="${address}"]`)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("This terminal didn't open")).toHaveCount(0);
});

test("a session renamed and ended on a phone is removed even when the page closes as soon as End is confirmed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const link = await routeHcSocket(page);
  await page.goto("/");
  await expect(agentsList(page)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("the new terminal has no address");
  const name = `end-at-once-${address}`;
  const actions = page.getByRole("banner").getByRole("button", { name: /^Session actions for / });
  await actions.click();
  await page.getByRole("button", { name: "Rename…", exact: true }).click();
  await page
    .getByRole("dialog", { name: /^Rename / })
    .getByRole("textbox", { name: "Name" })
    .fill(name);
  await page.keyboard.press("Enter");
  await expect(screenOf(page, name)).toBeVisible();
  await actions.click();
  await page.getByRole("button", { name: "End session…", exact: true }).click();
  // The kill's answer has not come back when the page closes, as over a slow relay: the answer is held, never released.
  link.holdFromHost('"state":"finished"');
  await page
    .getByRole("dialog", { name: `End ${name}?` })
    .getByRole("button", { name: "End session" })
    .click();
  // A role query for the terminal screen already reads it as gone: the End question hides the page behind it.
  await expect(page.getByRole("button", { name: "Back to agents" })).toHaveCount(0);
  await expect.poll(() => link.sent().some((frame) => frame.includes('"method":"terminal.kill"'))).toBe(true);
  await page.close();

  await expect.poll(() => onCore(address), { timeout: 10_000, message: `${address} still on the core` }).toBe(false);
});

test("an End that never reaches the core says so, and a second End finishes it", async ({ page }) => {
  const { link, name, address } = await phoneWithTerminal(page, "end-fails");
  const deliver = await endHolding(page, link, name, "terminal.label", "terminal.kill");
  // The link drops before End's mark and kill reach the core: End fails, and the program still runs.
  const sockets = link.opened();
  await link.drop(false);
  const ask = page.getByRole("dialog", { name: `End ${name}?` });
  await expect(ask.getByRole("alert")).toContainText("The session did not end", { timeout: 15_000 });
  await expect(ask.getByRole("button", { name: "End session" })).not.toHaveAttribute("aria-busy", "true");
  expect(hc("ls", "--json")).toContain(`"${address}"`);
  // Once the link is back (a new socket, and no connection notice: a tag query, as the dialog hides the page from roles),
  // try again; its own mark and kill are held until they are out, so its success is what removes the terminal.
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(sockets);
  await expect(page.locator('[role="status"]', { hasText: /Reconnecting|Offline/ })).toHaveCount(0, {
    timeout: 15_000,
  });
  const kills = () => link.sent().filter((frame) => frame.includes('"method":"terminal.kill"')).length;
  const before = kills();
  await ask.getByRole("button", { name: "End session" }).click();
  await expect.poll(kills).toBeGreaterThan(before);
  deliver();
  await expect(ask).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => onCore(address), { timeout: 10_000, message: `${address} still on the core` }).toBe(false);
});

test("a session the host removes while End's own removal is held closes the question without an error", async ({
  page,
}) => {
  const { link, name, address } = await phoneWithTerminal(page, "end-elsewhere");
  const deliver = await endHolding(page, link, name, "terminal.rm");
  // The host removes the marked terminal once it has finished; End's own terminal.rm then finds it gone.
  await expect.poll(() => onCore(address), { timeout: 10_000 }).toBe(false);
  deliver();
  const ask = page.getByRole("dialog", { name: `End ${name}?` });
  await expect(ask).toHaveCount(0, { timeout: 15_000 });
  await expect(agentsList(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

/** Holds End's kill, lets its mark reach the core, then drops the link: End fails and the program runs on. */
async function endFailsAfterMark(page: Page, link: HcSocket, name: string, address: string) {
  await endHolding(page, link, name, "terminal.kill");
  await expect.poll(() => terminalOf(address).marked).toBe(true);
  const sockets = link.opened();
  await link.drop(false);
  const ask = page.getByRole("dialog", { name: `End ${name}?` });
  await expect(ask.getByRole("alert")).toContainText("The session did not end", { timeout: 15_000 });
  return { ask, sockets };
}

test("a session whose End failed after its mark keeps its output when its program later exits by itself", async ({
  page,
}) => {
  const { link, name, address } = await phoneWithTerminal(page, "end-then-exit");
  await endFailsAfterMark(page, link, name, address);
  hc("send", address, `echo kept-${address}; exit 3`);
  await expect.poll(() => terminalOf(address).state, { timeout: 15_000 }).toBe("finished");
  // A marked terminal killed after it: once the host has removed that one, it has seen this one finish.
  const killed = hcRun("sh", "-c", "exec sleep 600");
  hc("label", killed, "herdr.end=1");
  hc("kill", killed);
  await expect.poll(() => onCore(killed), { timeout: 10_000 }).toBe(false);
  expect(terminalOf(address)).toMatchObject({ state: "finished", reason: "exited" });
  expect(hc("read", address)).toContain(`kept-${address}`);
});

test("dismissing a failed End takes its mark off the session, which runs on", async ({ page }) => {
  const { link, name, address } = await phoneWithTerminal(page, "end-dismissed");
  const { ask, sockets } = await endFailsAfterMark(page, link, name, address);
  await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(sockets);
  await expect(page.locator('[role="status"]', { hasText: /Reconnecting|Offline/ })).toHaveCount(0, {
    timeout: 15_000,
  });
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect.poll(() => terminalOf(address).marked).toBe(false);
  expect(terminalOf(address).state).toBe("live");
  // It ran on as it should; ended here, it is not left for a later spec to find (#226).
  hc("kill", address);
  hc("rm", address);
  expect(onCore(address)).toBe(false);
});
