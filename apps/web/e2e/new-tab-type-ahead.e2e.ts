import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const focused = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');
const mac = (page: Page) => page.evaluate(() => /mac/i.test(navigator.platform));
const catcher = (page: Page) => page.locator("[data-type-ahead]");

/** What the terminal's screen holds on the core itself, so nothing on the page can stand in for it. */
function screenOnCore(address: string): string[] {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

const runsSent = (link: HcSocket): number =>
  link.sent().filter((frame) => frame.includes('"method":"terminal.run"')).length;

const LINE = "echo ahead-$((40+2))";

type Via = "keys" | "button" | "palette";

/** Asks for a new tab the way a person would, from the previous terminal. */
async function askNewTab(page: Page, previous: ReturnType<Page["locator"]>, via: Via): Promise<void> {
  if (via === "button") return void (await page.getByRole("button", { name: "New tab" }).first().click());
  await previous.getByRole("textbox").focus();
  const onMac = await mac(page);
  if (via === "keys") return void (await page.keyboard.press(onMac ? "Meta+KeyT" : "Control+Shift+KeyT"));
  await page.keyboard.press(onMac ? "Meta+Shift+KeyP" : "Control+Shift+KeyP");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("New tab");
  await page.keyboard.press("Enter");
}

for (const via of ["keys", "button", "palette"] as const) {
  test(`typing straight after a new tab (${via}) reaches the new terminal in full, and the previous one gets nothing`, async ({
    page,
  }) => {
    const link = await routeHcSocket(page);
    await page.goto("/");
    const previous = await openNewTerminal(page);
    const address = await previous.getAttribute("data-terminal");
    if (address === null) throw new Error("the previous terminal has no address");
    const previousScreen = screenOnCore(address);

    // The new terminal is held back: its terminal.run waits, so every key is typed before it can exist.
    const before = runsSent(link);
    const release = link.hold("terminal.run");
    await askNewTab(page, previous, via);
    await page.keyboard.type(LINE, { delay: 40 });
    await page.keyboard.press("Enter");
    // One new tab was asked for: the space and Enter typed meanwhile must not press New tab again.
    expect(runsSent(link) - before).toBe(1);
    release();

    await expect
      .poll(async () => await focused(page).getAttribute("data-terminal"), { timeout: 15_000 })
      .not.toBe(address);
    const fresh = focused(page);
    await expect(fresh).toContainText("ahead-42", { timeout: 15_000 });
    await expect(fresh).toContainText(LINE);
    expect(screenOnCore(address)).toEqual(previousScreen);
    await expect(catcher(page)).toHaveAttribute("inert", "");
  });
}

test("while no terminal is being started the holding input is out of the page: not announced, not focusable", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  await expect(catcher(page)).toHaveAttribute("inert", "");
  await expect(catcher(page)).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("textbox", { name: /New terminal starting/ })).toHaveCount(0);
  const took = await catcher(page).evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    return document.activeElement === element;
  });
  expect(took).toBe(false);
});

test("input typed for a terminal that fails to start is reported as not sent, and reaches no other terminal", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const previous = await openNewTerminal(page);
  const address = await previous.getAttribute("data-terminal");
  if (address === null) throw new Error("the previous terminal has no address");
  const previousScreen = screenOnCore(address);
  link.hold("terminal.run");
  await askNewTab(page, previous, "keys");
  await page.keyboard.type(LINE, { delay: 40 });
  // The line drops while terminal.run is unanswered, so the run fails.
  await link.drop(true);
  await expect(page.getByText("What you typed was not sent")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/did not start/)).toBeVisible();
  link.restore();
  expect(screenOnCore(address)).toEqual(previousScreen);
});

/**
 * Counts, in the page, the MutationObservers watching the whole body and the terminal.run answers the app has handled:
 * `runAnswers` moves a task after the WebSocket listener that took the answer, so every reaction to it has run.
 */
const COUNT_LATE_WORK = `{
  const live = new Set();
  const Base = MutationObserver;
  window.MutationObserver = class extends Base {
    observe(target, options) {
      if (target === document.body && options?.subtree) live.add(this);
      return super.observe(target, options);
    }
    disconnect() {
      live.delete(this);
      return super.disconnect();
    }
  };
  window.lateWork = { bodyObservers: () => live.size, runAnswers: 0 };
  const sockets = [];
  const Native = WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      sockets.push(this);
      this.addEventListener("message", (event) => {
        const text = event.data instanceof ArrayBuffer ? new TextDecoder("latin1").decode(event.data) : String(event.data);
        const answer = (text.includes('"result":{') && text.includes('"address"')) || text.includes('"error":{');
        if (!answer) return;
        // A task after this message's whole dispatch: every listener, and the promise reactions they started, have run.
        const channel = new MessageChannel();
        channel.port1.onmessage = () => void (window.lateWork.runAnswers += 1);
        channel.port2.postMessage(0);
      });
    }
  };
}`;

const bodyObservers = (page: Page) =>
  page.evaluate(() => (window as unknown as { lateWork: { bodyObservers: () => number } }).lateWork.bodyObservers());
const runAnswers = (page: Page) =>
  page.evaluate(() => (window as unknown as { lateWork: { runAnswers: number } }).lateWork.runAnswers);

/** Asks for a new tab with terminal.run held and keys typed for it, then leaves the workspace for Settings. */
async function leaveWhileStarting(page: Page, link: HcSocket): Promise<(fail?: boolean) => void> {
  const previous = await openNewTerminal(page);
  const release = link.hold("terminal.run");
  await askNewTab(page, previous, "keys");
  await page.keyboard.type(LINE, { delay: 40 });
  await page.getByRole("link", { name: "Settings" }).first().click();
  await expect(page.locator("[data-terminal]")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
  return release;
}

test("a run that answers after the workspace closed arms no observer or timer and shows no toast", async ({ page }) => {
  await page.addInitScript({ content: COUNT_LATE_WORK });
  const link = await routeHcSocket(page);
  await page.clock.install();
  await page.goto("/");
  const release = await leaveWhileStarting(page, link);
  const observers = await bodyObservers(page);
  const answers = await runAnswers(page);

  release();
  await expect.poll(() => runAnswers(page), { timeout: 15_000 }).toBeGreaterThan(answers);
  // The late answer armed nothing: no observer waits for the new terminal's view, and no budget timer runs out.
  expect(await bodyObservers(page)).toBe(observers);
  await page.clock.runFor(16_000);
  await expect(page.getByText("What you typed was not sent")).toHaveCount(0);
  await expect(page.getByText(/did not start/)).toHaveCount(0);
});

test("input typed for a terminal whose view does not open in time is reported as not sent", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.clock.install();
  await page.goto("/");
  const previous = await openNewTerminal(page);
  const address = await previous.getAttribute("data-terminal");
  if (address === null) throw new Error("the previous terminal has no address");
  const previousScreen = screenOnCore(address);
  const answered = (): number => link.received().filter((frame) => /"result":\{[^}]*"address"/.test(frame)).length;
  const answersBefore = answered();
  // The feed is held, so the new terminal is never listed and its view cannot mount.
  const releaseFeed = link.holdFromHost('"method":"event"', '"method":"heartbeat"', '"method":"missed"');
  await askNewTab(page, previous, "keys");
  await page.keyboard.type(LINE, { delay: 40 });
  await expect.poll(answered, { timeout: 15_000 }).toBeGreaterThan(answersBefore);
  // The route has seen the answer, but the page may not have handled it yet: the budget timer is armed only once it
  // has. A MessageChannel task posted now runs after the answer's WebSocket message task and the promise chain it
  // settles, so the clock is run only after the timer exists.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.addEventListener("message", () => resolve(), { once: true });
        channel.port1.start();
        channel.port2.postMessage(null);
      }),
  );
  await page.clock.runFor(16_000);
  await expect(page.getByText("What you typed was not sent")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/took too long/)).toBeVisible();
  releaseFeed();
  expect(screenOnCore(address)).toEqual(previousScreen);
});
