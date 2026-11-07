// #560: terminals printing as fast as they can must not starve the page. Three terminals flood (the one in view and two
// in hidden tabs) and a click on the active tab's Close must still bring its question up at once. confirm-close-surface
// is `always`, so the question does not depend on what hc last reported running there.
import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import { E2E_HOST_ENV } from "./config.ts";
import { setConfirmClose } from "./close-confirm.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { tabs } from "./tab-strip.ts";

endOwnTerminals();
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

// A shell loop, as in #560: each echo is its own write, so output arrives as a stream of small chunks.
const FLOOD = "i=0; while :; do i=$((i+1)); echo flood-$i-$i-$i-$i; done";

/**
 * From a real click on the active tab's close button to its question on screen: the pointerdown's timeStamp is when the
 * browser took the input, so time the click waited behind a busy main thread counts. 10 s when it never comes.
 */
async function clickToDialog(page: Page): Promise<number> {
  await page.evaluate(() => {
    const probe = { pressed: 0, asked: 0 };
    Object.assign(window, { probe });
    document.addEventListener("pointerdown", (event) => (probe.pressed = event.timeStamp), {
      capture: true,
      once: true,
    });
    const seen = new MutationObserver(() => {
      if (document.querySelector('[role="dialog"]') === null) return;
      seen.disconnect();
      probe.asked = performance.now();
    });
    seen.observe(document.body, { childList: true, subtree: true });
  });
  const box = await page
    .locator("[data-tab-id]")
    .filter({ has: page.getByRole("tab", { selected: true }) })
    .locator("[data-tab-close]")
    .boundingBox();
  if (box === null) throw new Error("no close button");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const probe = page.waitForFunction(
    () => {
      const { pressed, asked } = Reflect.get(window, "probe") as { pressed: number; asked: number };
      return asked > 0 && pressed > 0 ? asked - pressed : null;
    },
    undefined,
    { timeout: 10_000 },
  );
  return probe.then((handle) => handle.jsonValue() as Promise<number>).catch(() => 10_000);
}

test("with three terminals flooding, Close still asks on every click (#560)", async ({ page }) => {
  test.setTimeout(180_000);
  await setConfirmClose(page, "always");
  await openNewTerminal(page);
  await openNewTerminal(page);
  await openNewTerminal(page);
  await expect(tabs(page)).toHaveCount(3);
  const flood = async (index: number): Promise<void> => {
    await tabs(page).nth(index).click();
    await page.locator('[data-focused="true"] [data-terminal]').getByRole("textbox").focus();
    await page.keyboard.type(`${FLOOD}\r`);
  };
  await flood(0);
  await flood(1);
  await tabs(page).nth(2).click();
  const active = page.locator('[data-focused="true"] [data-terminal]');
  await active.getByRole("textbox").focus();
  await page.keyboard.type(`${FLOOD}\r`);
  await expect(active).toContainText("flood-", { timeout: 15_000 });
  await page.evaluate(() => {
    const longTasks: number[] = [];
    Object.assign(window, { longTasks });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ type: "longtask" });
  });

  const times: number[] = [];
  const askAndCancel = async (): Promise<void> => {
    const ms = await clickToDialog(page);
    times.push(ms);
    if (ms >= 10_000) throw new Error(`no Close question within 10 s of the click (so far: ${times.join(", ")} ms)`);
    await page
      .getByRole("dialog", { name: /^Close/ })
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(page.getByRole("dialog", { name: /^Close/ })).toHaveCount(0);
  };
  await [1, 2, 3].reduce<Promise<void>>((previous) => previous.then(askAndCancel), Promise.resolve());
  const longTasks = await page.evaluate(() => (Reflect.get(window, "longTasks") as number[]).length);
  // How soon is the render bench's to judge (closePromptMs, bench/thresholds.json: 200 ms), on a runner with nothing
  // else on it and against the last release (#986). Here, on a runner shared with the rest of the suite, the time
  // measures how much CPU the page got: this case holds that every click is answered, within the 10 s above.
  console.log(`#560 click-to-dialog ms: ${times.map((ms) => Math.round(ms)).join(", ")}; long tasks: ${longTasks}`);
});

const DATA = 0;
const CREDIT = 1;

/** Payload bytes of hc frames of one kind per channel, in messages read as latin1 text (hc-socket's form). */
function frameBytes(messages: readonly string[], kind: number): Map<number, number> {
  const totals = new Map<number, number>();
  for (const message of messages) {
    const bytes = Buffer.from(message, "latin1");
    for (let at = 0; at + 9 <= bytes.byteLength; at += 9 + bytes.readUInt32LE(at + 5)) {
      if (bytes[at + 4] !== kind) continue;
      const channel = bytes.readUInt32LE(at);
      const size = kind === CREDIT ? bytes.readUInt32LE(at + 9) : bytes.readUInt32LE(at + 5);
      totals.set(channel, (totals.get(channel) ?? 0) + size);
    }
  }
  return totals;
}

/** DATA received and CREDIT sent on the flooding terminal's stream: the channel that carried the most output. */
function flow(link: HcSocket): { data: number; credit: number } {
  const data = frameBytes(link.received(), DATA);
  const [channel] = [...data].reduce((most, entry) => (entry[1] > most[1] ? entry : most), [-1, -1]);
  return { data: data.get(channel) ?? 0, credit: frameBytes(link.sent(), CREDIT).get(channel) ?? 0 };
}

/** The highest flood line number in a terminal's rows. */
const lastFlood = (terminal: Locator) =>
  terminal.evaluate((element) =>
    Math.max(0, ...[...(element.textContent ?? "").matchAll(/flood-(\d+)-/g)].map((match) => Number(match[1]))),
  );

/** The highest flood line number on the core's own screen of a terminal, read with hc. */
function lastFloodOnCore(address: string): number {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const screen = execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" });
  return Math.max(0, ...[...screen.matchAll(/flood-(\d+)-/g)].map((match) => Number(match[1])));
}

test("credit goes back only for output the page has drawn, so the 256 KiB window holds a flood back (#560)", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`${FLOOD}\r`);
  await expect(terminal).toContainText("flood-", { timeout: 15_000 });
  // The page stops drawing: no animation frame runs from here.
  await page.evaluate(() => {
    const frames = window.requestAnimationFrame.bind(window);
    const waiting: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (run) => waiting.push(run);
    Object.assign(window, {
      restoreFrames: () => {
        window.requestAnimationFrame = frames;
        for (const run of waiting.splice(0)) frames(run);
      },
    });
  });
  // Frames already asked for run once; then the flow settles.
  await page.waitForTimeout(500);
  const before = flow(link);
  await page.waitForTimeout(2_000);
  const after = flow(link);
  expect(after.credit - before.credit).toBe(0);
  expect(after.data - before.data).toBeLessThanOrEqual(256 * 1024);

  const seen = await lastFlood(terminal);
  await page.evaluate(() => (Reflect.get(window, "restoreFrames") as () => void)());
  await expect.poll(() => lastFlood(terminal), { timeout: 15_000 }).toBeGreaterThan(seen);
  expect(flow(link).credit).toBeGreaterThan(after.credit);
});

test("a terminal in a hidden tab is not drawn while its program floods, and catches up once shown (#560)", async ({
  page,
}) => {
  await page.goto("/");
  const flooding = await openNewTerminal(page);
  await flooding.getByRole("textbox").focus();
  await page.keyboard.type(`${FLOOD}\r`);
  await expect(flooding).toContainText("flood-", { timeout: 15_000 });
  await openNewTerminal(page);
  await expect(tabs(page)).toHaveCount(2);
  await expect(flooding).toBeHidden();

  await flooding.evaluate((element) => {
    const drawn = { rows: 0, scrolls: 0 };
    Object.assign(window, { drawn });
    new MutationObserver((records) => (drawn.rows += records.length)).observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    element.addEventListener("scroll", () => (drawn.scrolls += 1), { capture: true });
  });
  const top = await flooding.evaluate((element) => element.querySelector(".wterm")?.scrollTop ?? element.scrollTop);
  const address = await flooding.getAttribute("data-terminal");
  if (address === null) throw new Error("the flooding terminal has no address");
  const coreBefore = lastFloodOnCore(address);
  await page.waitForTimeout(2_000);
  console.log(`#560 hidden: the core's screen went from flood-${coreBefore} to flood-${lastFloodOnCore(address)}`);
  expect(await page.evaluate(() => Reflect.get(window, "drawn"))).toEqual({ rows: 0, scrolls: 0 });
  expect(await flooding.evaluate((element) => element.querySelector(".wterm")?.scrollTop ?? element.scrollTop)).toBe(
    top,
  );

  const seen = await lastFlood(flooding);
  await tabs(page).nth(0).click();
  await expect(flooding).toBeVisible();
  await expect.poll(() => lastFlood(flooding), { timeout: 15_000 }).toBeGreaterThan(seen);
});
