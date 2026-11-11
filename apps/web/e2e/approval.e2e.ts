import type { Page } from "@playwright/test";
import { WAITING_ANNOUNCEMENT } from "../src/approval/waiting-keys.ts";
import { agentRow } from "./agents.ts";
import { type AskingAgent, startAskingAgent } from "./approval-agent.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

let agent: AskingAgent;
let name: string;
let started = false;

/** Starts this test's asking agent; every test ends it, started or not by then. */
function ask(): void {
  name = `asks-${crypto.randomUUID().slice(0, 8)}`;
  agent = startAskingAgent(name);
  started = true;
}

test.afterEach(() => {
  if (started) agent.end();
  started = false;
});

const banner = (page: Page) => page.locator(`[data-approval="${agent.address}"]`);

/** The card's row for the agent's own "Yes" (`1`), and its cancel (Esc). */
const yes = (page: Page) => banner(page).locator('[data-option="1"]');
const cancel = (page: Page) => banner(page).locator("[data-cancel]");

/** Opens the asking agent's pane and waits for its card to offer the dialog's rows. */
async function openAsking(page: Page): Promise<void> {
  await expect(agentRow(page, name, false)).toBeVisible({ timeout: 20_000 });
  await agentRow(page, name, false).click();
  await expect(banner(page)).toContainText("Claude Code", { timeout: 15_000 });
  await expect(banner(page)).toContainText("touch probe-a.txt");
  await expect(yes(page)).toBeEnabled();
  await expect(yes(page)).toHaveText(/Yes$/);
}

test("Yes presses the agent's own key once, and the card says it was answered from here", async ({ page }) => {
  ask();
  await page.goto("/");
  await openAsking(page);
  await yes(page).click();
  await expect(banner(page)).toContainText("from this device", { timeout: 10_000 });
  await expect(banner(page)).toContainText("Yes");
  await expect.poll(agent.keys, { timeout: 10_000 }).toEqual(["1"]);
  await expect(page.locator(`[data-terminal="${agent.address}"]`)).toContainText("Allowed", { timeout: 10_000 });
  const [record] = agent.records();
  expect(record).toMatchObject({
    answer: "allow",
    choice: "Yes",
    outcome: "sent",
    by: expect.stringContaining("Chrome"),
  });
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 });
});

test("Cancel presses Esc, for an agent that starts asking while the page is open", async ({ page }) => {
  // Known only from events, this terminal has no status_ms on the page (hc's status event carries none).
  await page.goto("/");
  await expect(page.getByRole("contentinfo")).toContainText(/\d+ terminals?/, { timeout: 20_000 });
  ask();
  await openAsking(page);
  await cancel(page).click();
  await expect(banner(page)).toContainText("Cancel", { timeout: 10_000 });
  await expect(banner(page)).toContainText("from this device");
  await expect.poll(agent.keys, { timeout: 10_000 }).toEqual(["\u001B"]);
  expect(agent.records()).toMatchObject([{ answer: "deny", choice: "Cancel", outcome: "sent" }]);
});

test("stale: answered in the terminal before the status caught up, so the banner sends nothing", async ({ page }) => {
  ask();
  await page.goto("/");
  await openAsking(page);
  agent.typeInTerminal("x");
  await expect.poll(agent.keys, { timeout: 10_000 }).toEqual(["x"]);
  await expect(page.locator(`[data-terminal="${agent.address}"]`)).toContainText("Answered in the terminal", {
    timeout: 10_000,
  });
  // The status still says blocked, so the card still offers Yes; the re-read before the key press finds no prompt.
  await yes(page).click();
  await expect(banner(page)).toContainText("The prompt went away.", { timeout: 10_000 });
  expect(agent.keys()).toEqual(["x"]);
  expect(agent.records()).toMatchObject([{ answer: "allow", outcome: "stale" }]);
  await banner(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(banner(page)).toHaveCount(0);
});

test("two clients racing on one prompt: exactly one answer reaches the agent, the other says where it was answered", async ({
  page,
}) => {
  ask();
  const slow = page;
  const slowLink = await routeHcSocket(slow);
  await slow.goto("/");
  await openAsking(slow);
  const fast = await page.context().newPage();
  await fast.goto("/");
  await openAsking(fast);

  // Both press Yes while the prompt is up; the slow client's claim is held on its way to the core, so the fast one
  // claims first, re-reads the screen and presses the key. Then the slow claim reaches the core and finds it taken.
  const release = slowLink.hold("doc.set");
  await yes(slow).click();
  await expect(banner(slow)).toContainText("Checking the prompt is still on screen");
  await yes(fast).click();
  await expect(banner(fast)).toContainText("from this device", { timeout: 10_000 });
  release();
  await expect(banner(slow)).toContainText("Answered on another device (", { timeout: 10_000 });

  await expect.poll(agent.keys, { timeout: 10_000 }).toEqual(["1"]);
  expect(agent.records()).toHaveLength(1);
  await fast.close();
});

test("a link that drops between the claim and the key press shows the failure, presses nothing, and Try again answers", async ({
  page,
}) => {
  ask();
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openAsking(page);
  // The claim reaches the core; the re-read of the screen is held, then the link drops under it. The banner's own first
  // read already sent a terminal.read; the re-read is the next one, sent only once the claim's doc.set was answered.
  const reads = () => link.sent().filter((frame) => frame.includes('"method":"terminal.read"')).length;
  const readsBefore = reads();
  link.hold("terminal.read");
  await yes(page).click();
  await expect.poll(reads, { timeout: 10_000 }).toBeGreaterThan(readsBefore);
  expect(agent.records()).toMatchObject([{ answer: "allow", outcome: "claimed" }]);
  const sockets = link.opened();
  await link.drop(true);
  link.hold();
  await expect(banner(page)).toContainText("The answer did not go through.", { timeout: 15_000 });
  await expect(banner(page)).not.toContainText("from this device");
  expect(agent.keys()).toEqual([]);

  link.restore();
  await expect.poll(link.opened, { timeout: 20_000 }).toBeGreaterThan(sockets);
  await banner(page).getByRole("button", { name: "Try again" }).click();
  await expect(banner(page)).toContainText("from this device", { timeout: 15_000 });
  await expect.poll(agent.keys, { timeout: 10_000 }).toEqual(["1"]);
  expect(agent.records()).toMatchObject([{ answer: "allow", outcome: "sent", by: expect.stringContaining("Chrome") }]);
});

test("the prompt is announced: the pane's live region is there, empty, before the banner's text is written into it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("contentinfo")).toContainText(/\d+ terminals?/, { timeout: 20_000 });
  // Every live region's text from the moment it is inserted, in order.
  await page.evaluate(() => {
    const seen = new Map<Element, string[]>();
    Reflect.set(window, "__approvalLive", seen);
    const note = () => {
      for (const region of document.querySelectorAll("[data-approval-live]")) {
        const texts = seen.get(region) ?? [];
        const text = region.textContent ?? "";
        if (texts.at(-1) !== text || texts.length === 0) texts.push(text);
        seen.set(region, texts);
      }
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
    note();
  });
  ask();
  await openAsking(page);
  const history = () =>
    page.evaluate((address) => {
      const seen: unknown = Reflect.get(window, "__approvalLive");
      if (!(seen instanceof Map)) return [];
      const region = document.querySelector(`[data-approval-live="${address}"]`);
      const texts: unknown = region === null ? undefined : seen.get(region);
      return Array.isArray(texts) ? texts.map(String) : [];
    }, agent.address);
  await expect.poll(history, { timeout: 10_000 }).toContainEqual(expect.stringContaining("Claude Code wants to run"));
  expect((await history())[0]).toBe("");
  // The keys strip, which stands in where no card comes, never showed while the card was being read (#1555).
  expect(await history()).not.toContainEqual(WAITING_ANNOUNCEMENT);
  await expect(page.locator(`[data-approval-live="${agent.address}"]`)).toHaveAttribute("aria-live", "polite");
});
