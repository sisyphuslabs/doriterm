// #560: terminals printing as fast as they can must not starve the page. Three terminals flood (the one in view and two
// in hidden tabs) and a click on the active tab's Close must still bring its question up at once. confirm-close-surface
// is `always`, so the question does not depend on what hc last reported running there.
import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import { E2E_HOST_ENV } from "./config.ts";
import { setConfirmClose } from "./close-confirm.ts";
import { clickToDialog } from "./close-probe.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { tabs } from "./tab-strip.ts";

endOwnTerminals();
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

// A shell loop, as in #560: each echo is its own write, so output arrives as a stream of small chunks.
const FLOOD = "i=0; while :; do i=$((i+1)); echo flood-$i-$i-$i-$i; done";

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
    if (ms === null) throw new Error(`no Close question within 10 s of the click (so far: ${times.join(", ")} ms)`);
    times.push(ms);
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
function flow(link: HcSocket): { channel: number; data: number; credit: number } {
  const data = frameBytes(link.received(), DATA);
  const [channel] = [...data].reduce((most, entry) => (entry[1] > most[1] ? entry : most), [-1, -1]);
  return { channel, data: data.get(channel) ?? 0, credit: frameBytes(link.sent(), CREDIT).get(channel) ?? 0 };
}

/**
 * From here on the page counts the credit it hands its sockets, per channel (`window.creditSent`). The route carries
 * each frame on when it gets to it, so a spec can wait until it has carried every credit the page sent.
 */
async function countCreditSent(page: Page): Promise<void> {
  await page.evaluate((kind) => {
    const sent = new Map<number, number>();
    Object.assign(window, { creditSent: sent });
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data) {
      if (data instanceof Uint8Array) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let at = 0; at + 9 <= data.byteLength; at += 9 + view.getUint32(at + 5, true)) {
          if (data[at + 4] !== kind) continue;
          const channel = view.getUint32(at, true);
          sent.set(channel, (sent.get(channel) ?? 0) + view.getUint32(at + 9, true));
        }
      }
      send.call(this, data);
    };
  }, CREDIT);
}

/** How long a terminal that draws again has to draw a newer flood line, inside the cases' 180 s budget (#2205). */
const DRAW_MS = 100_000;

/**
 * Arms, in the page, a wait for the first flood line drawn in `terminal` past the largest it shows now, and returns that
 * largest. The draw is caught as the page makes it rather than by reading the whole screen back over and over, which
 * took seconds a read on a loaded runner (#2108); {@link drawnFlood} awaits it.
 */
const armFloodDraw = (terminal: Locator): Promise<number> =>
  terminal.evaluate((element, ms) => {
    let shown = 0;
    for (const match of (element.textContent ?? "").matchAll(/flood-(\d+)-/g))
      shown = Math.max(shown, Number(match[1]));
    const drawn = new Promise<number>((resolve, reject) => {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const texts =
            record.type === "characterData"
              ? [record.target.textContent ?? ""]
              : [...record.addedNodes].map((node) => node.textContent ?? "");
          for (const text of texts)
            for (const match of text.matchAll(/flood-(\d+)-/g)) {
              if (Number(match[1]) <= shown) continue;
              observer.disconnect();
              clearTimeout(late);
              resolve(Number(match[1]));
              return;
            }
        }
      });
      const late = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`no flood line past flood-${shown} was drawn within ${ms} ms`));
      }, ms);
      observer.observe(element, { childList: true, characterData: true, subtree: true });
    });
    Object.assign(window, { floodDrawn: drawn });
    return shown;
  }, DRAW_MS);

/** The flood line {@link armFloodDraw} caught being drawn, once it is. */
const drawnFlood = (page: Page): Promise<number> =>
  page.evaluate(() => Reflect.get(window, "floodDrawn") as Promise<number>);

/** The highest flood line number on the core's own screen of a terminal, read with hc. */
function lastFloodOnCore(address: string): number {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  const screen = execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" });
  return Math.max(0, ...[...screen.matchAll(/flood-(\d+)-/g)].map((match) => Number(match[1])));
}

test("credit goes back only for output the page has drawn, so the 256 KiB window holds a flood back (#560)", async ({
  page,
}) => {
  // A loaded runner takes tens of seconds over the draws below (#2108).
  test.setTimeout(180_000);
  const link = await routeHcSocket(page);
  await page.goto("/");
  await countCreditSent(page);
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`${FLOOD}\r`);
  await expect(terminal).toContainText("flood-", { timeout: 15_000 });
  // Credit for drawn output goes out a frame or more after the text shows, so frames stopped right here could leave the
  // flood's credit at 0 (#2493; runs here froze with as little as 264 bytes credited). Wait for the page to have credited
  // the flooding stream first. The stream is read inside the wait: just after the first line, setup traffic on another
  // channel can still lead, and that channel never gets credit.
  await expect
    .poll(
      () =>
        page.evaluate(
          (stream) => (Reflect.get(window, "creditSent") as Map<number, number>).get(stream) ?? 0,
          flow(link).channel,
        ),
      { message: "the page credits the flood it drew", timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  // The page stops drawing: no animation frame runs from here. A frame asked for now runs after every frame asked for
  // before it, so once it has run, the page has written, and credited, all it will until frames come back.
  await page.evaluate(async () => {
    const frames = window.requestAnimationFrame.bind(window);
    const waiting: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (run) => waiting.push(run);
    Object.assign(window, {
      restoreFrames: () => {
        window.requestAnimationFrame = frames;
        for (const run of waiting.splice(0)) frames(run);
      },
    });
    await new Promise((resolve) => frames(resolve));
  });
  // The window is measured once the route has carried every credit the page sent: one it carries late is not credit
  // given while nothing was drawn (#2108).
  const { channel } = flow(link);
  const credited = await page.evaluate(
    (stream) => (Reflect.get(window, "creditSent") as Map<number, number>).get(stream) ?? 0,
    channel,
  );
  // The page has drawn, and credited, the flood's first lines: a count of 0 means the counter misses its frames, and the
  // wait below would pass at once (#2205).
  expect(credited, "credit the page counted on the flooding stream").toBeGreaterThan(0);
  await expect.poll(() => flow(link).credit).toBeGreaterThanOrEqual(credited);
  const before = flow(link);
  await page.waitForTimeout(2_000);
  const after = flow(link);
  expect(after.credit - before.credit).toBe(0);
  expect(after.data - before.data).toBeLessThanOrEqual(256 * 1024);

  // Drawing again, the page draws output past what it showed, and gives credit for it.
  const seen = await armFloodDraw(terminal);
  await page.evaluate(() => (Reflect.get(window, "restoreFrames") as () => void)());
  expect(await drawnFlood(page)).toBeGreaterThan(seen);
  await expect.poll(() => flow(link).credit).toBeGreaterThan(after.credit);
});

test("a terminal in a hidden tab is not drawn while its program floods, and catches up once shown (#560)", async ({
  page,
}) => {
  // A loaded runner takes tens of seconds over the catch-up draw below (#2205).
  test.setTimeout(180_000);
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

  const seen = await armFloodDraw(flooding);
  await tabs(page).nth(0).click();
  await expect(flooding).toBeVisible();
  expect(await drawnFlood(page)).toBeGreaterThan(seen);
});
