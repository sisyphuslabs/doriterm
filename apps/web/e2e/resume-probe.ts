import type { Locator, Page } from "@playwright/test";

/**
 * Call before page.goto. A hidden document gets no animation frames in a browser, but headless Chromium keeps running
 * them for a page whose visibilityState a spec redefines: frames asked for while it reads "hidden" wait here until it
 * reads "visible" again, as they would. Also counts the messages the routed sockets whose URL contains `socketPath`
 * deliver (read with `pageMessages`), so a spec knows when every frame its route sent has reached the page:
 * Playwright's socket stand-in hands each one to the app with `dispatchEvent`, which a native socket never calls.
 */
export async function hiddenDocumentFrames(page: Page, socketPath: string): Promise<void> {
  await page.addInitScript((path) => {
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
      for (const [id, run] of parked) {
        parked.delete(id);
        book(id, run);
      }
    });

    let messages = 0;
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event): boolean {
      if (event instanceof MessageEvent && String(Reflect.get(this, "url") ?? "").includes(path)) messages += 1;
      return dispatch.call(this, event);
    };
    Reflect.set(window, "__socketMessages", () => messages);
  }, socketPath);
}

/** How many messages the counted sockets have handed the page (see `hiddenDocumentFrames`). */
export const pageMessages = (page: Page): Promise<number> =>
  page.evaluate(() => (Reflect.get(window, "__socketMessages") as () => number)());

/**
 * Records, for every frame as painted, the highest `line-N` on the terminal's screen rows (0 when none). Sampled in a
 * ResizeObserver callback, which runs after every animation-frame callback of the frame (the pacer's write, the
 * renderer) and before the paint, as e2e/prediction-frames.ts does. `before` runs right after the sampler is installed,
 * in the same task, so the first sample is the first frame after it.
 */
export async function startLastLineSampler(terminal: Locator, before: "show" | "nothing"): Promise<void> {
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

/** Stops the sampler and returns one highest line number per painted frame. */
export const sampledFrames = (page: Page): Promise<number[]> =>
  page.evaluate(() => (Reflect.get(window, "__lastLines") as () => number[])());

/** Tells the page it has gone to the background, the way a phone leaving the app does. */
export const hide = (page: Page): Promise<void> =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

/** How many times the sampled value changes from one frame to the next. */
export const transitions = (frames: readonly number[]): number =>
  frames.reduce((count, value, at) => (at > 0 && value !== frames[at - 1] ? count + 1 : count), 0);
