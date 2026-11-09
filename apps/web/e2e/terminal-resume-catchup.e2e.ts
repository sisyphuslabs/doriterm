import type { Locator, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { endAgent } from "./agents.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { readSavedEnv } from "./saved-env.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

const LAST = 4000;
/** Far more output than one frame's 16 KiB, so a paced replay shows up as frames that climb. */
const FLOOD = `for i in $(seq 1 ${LAST}); do echo line-$i; done`;

/** What the terminal's screen holds on the core itself, so nothing on the page can stand in for it. */
function screenOnCore(address: string): string {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" });
}

/**
 * Call before page.goto. A hidden document gets no animation frames in a browser, but headless Chromium keeps running
 * them for a page whose visibilityState a spec redefines: frames asked for while it reads "hidden" wait here until it
 * reads "visible" again, as they would. Also counts the messages the routed hc sockets deliver, so a spec knows when
 * every frame the route sent has reached the page: Playwright's socket stand-in hands each one to the app with
 * `dispatchEvent`, which a native socket never calls.
 */
async function hiddenDocumentFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const native = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const booked = new Map<number, number>();
    const parked = new Map<number, FrameRequestCallback>();
    let next = 1;
    const book = (id: number, run: FrameRequestCallback): void => {
      booked.set(
        id,
        native((time) => {
          booked.delete(id);
          if (document.visibilityState === "hidden") parked.set(id, run);
          else run(time);
        }),
      );
    };
    window.requestAnimationFrame = (run) => {
      const id = next;
      next += 1;
      book(id, run);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const real = booked.get(id);
      if (real !== undefined) cancel(real);
      booked.delete(id);
      parked.delete(id);
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") return;
      for (const [id, run] of [...parked]) {
        parked.delete(id);
        book(id, run);
      }
    });

    let messages = 0;
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event): boolean {
      if (event instanceof MessageEvent && String(Reflect.get(this, "url") ?? "").includes("/v1/hc")) messages += 1;
      return dispatch.call(this, event);
    };
    Reflect.set(window, "__hcMessages", () => messages);
  });
}

/** Resolves once the page has handled every frame the route has delivered so far. */
async function delivered(page: Page, link: HcSocket): Promise<void> {
  const sent = link.received().length;
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, "__hcMessages") as () => number)()))
    .toBeGreaterThanOrEqual(sent);
}

/**
 * Records, for every frame as painted, the highest `line-N` on the terminal's screen rows (0 when none). Sampled in a
 * ResizeObserver callback, which runs after every animation-frame callback of the frame (the pacer's write, the
 * renderer) and before the paint, as e2e/prediction-frames.ts does. `before` runs right after the sampler is installed,
 * in the same task, so the first sample is the first frame after it.
 */
async function startLastLineSampler(terminal: Locator, before: "show" | "nothing"): Promise<void> {
  await terminal.evaluate((element, then) => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10px;top:-10px;height:1px;pointer-events:none";
    document.body.appendChild(probe);
    const samples: number[] = [];
    let frame = 0;
    let on = true;
    const sample = (): void => {
      let last = 0;
      for (const row of element.querySelectorAll(".term-grid .term-row:not(.term-scrollback-row)"))
        for (const match of (row.textContent ?? "").matchAll(/line-(\d+)/g)) last = Math.max(last, Number(match[1]));
      samples.push(last);
    };
    new ResizeObserver(() => {
      if (on) sample();
    }).observe(probe);
    const tick = (): void => {
      frame += 1;
      probe.style.width = `${1 + (frame % 2)}px`;
      if (on) requestAnimationFrame(tick);
    };
    Reflect.set(window, "__lastLines", () => {
      on = false;
      probe.remove();
      return samples;
    });
    if (then === "show") {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      requestAnimationFrame(tick);
      document.dispatchEvent(new Event("visibilitychange"));
    } else requestAnimationFrame(tick);
  }, before);
}

const sampledFrames = (page: Page): Promise<number[]> =>
  page.evaluate(() => (Reflect.get(window, "__lastLines") as () => number[])());

/** Tells the page it has gone to the background, the way a phone leaving the app does. */
const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

/** How many times the sampled value changes from one frame to the next. */
const transitions = (frames: readonly number[]): number =>
  frames.reduce((count, value, at) => (at > 0 && value !== frames[at - 1] ? count + 1 : count), 0);

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    if (device === "phone") test.use({ ...PHONE });

    async function terminalFor(page: Page): Promise<{ readonly terminal: Locator; readonly address: string }> {
      let terminal: Locator;
      if (device === "phone") terminal = await openPhoneTerminal(page);
      else {
        await page.goto("/");
        terminal = await openNewTerminal(page);
        await terminal.getByRole("textbox").focus();
      }
      const address = (await terminal.getAttribute("data-terminal")) ?? "";
      opened.push(address);
      return { terminal, address };
    }

    test("coming back to the app paints the screen as it is now in its first frame, not a replay (D5)", async ({
      page,
    }) => {
      await hiddenDocumentFrames(page);
      const link = await routeHcSocket(page);
      const { terminal, address } = await terminalFor(page);

      // Everything the program prints arrives while the app is in the background.
      const release = link.holdFromHost("");
      await page.keyboard.type(FLOOD);
      await page.keyboard.press("Enter");
      await hide(page);
      await expect.poll(() => screenOnCore(address), { timeout: 20_000 }).toContain(`line-${LAST}`);
      release();
      await delivered(page, link);

      await startLastLineSampler(terminal, "show");
      await expect(terminal).toContainText(`line-${LAST}`, { timeout: 15_000 });
      const frames = await sampledFrames(page);
      expect(frames.length).toBeGreaterThan(0);
      // The first frame after the app shows already holds the last line: no frame climbs toward it.
      expect(frames[0]).toBe(LAST);
      expect(frames.filter((last) => last !== LAST)).toEqual([]);
    });

    test("a reconnect's replay is painted once it has settled: the screen never climbs back (D5, #1040)", async ({
      page,
    }) => {
      await page.addInitScript(() => {
        Reflect.set(window, "__dorifaceAttachLog", []);
      });
      const link = await routeHcSocket(page);
      const { terminal } = await terminalFor(page);
      await page.keyboard.type(FLOOD);
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText(`line-${LAST}`, { timeout: 20_000 });

      await startLastLineSampler(terminal, "nothing");
      const before = link.opened();
      await link.drop(true);
      link.restore();
      await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(before);
      await expect
        .poll(() => page.evaluate(() => (Reflect.get(window, "__dorifaceAttachLog") as unknown[]).length))
        .toBeGreaterThanOrEqual(2);
      // Output after the replay marks the replay as delivered and painted.
      await page.keyboard.type("echo done-$((1+1))");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("done-2", { timeout: 15_000 });
      const frames = await sampledFrames(page);

      expect(frames.length).toBeGreaterThan(0);
      expect(frames.at(-1)).toBe(LAST);
      // The old screen stays until the replay is drawn whole: at most one change, never an empty or climbing screen.
      expect(transitions(frames)).toBeLessThanOrEqual(1);
      expect(frames.filter((last) => last !== LAST)).toEqual([]);
    });
  });
}
