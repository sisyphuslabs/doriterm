import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { E2E_HOST_PORT } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

const LAST = 4000;
/** The window title the shell sets once it has printed the last line. */
const FLOOD_END = "catchup-flood-end";
/**
 * Far more output than one frame's 16 KiB, so a paced replay shows up as frames that climb. Then the title: the core
 * sends it as an event behind the output on the same stream, and the page shows it without painting the terminal, so
 * the title in the pane's name means every line has reached the page, held or not.
 */
const FLOOD = `for i in $(seq 1 ${LAST}); do echo line-$i; done; printf '\\033]2;${FLOOD_END}\\007'`;
/** hc's wire frame header: channel (u32), kind (u8), payload length (u32), little-endian; channel 0 carries the RPC. */
const HC_HEADER_BYTES = 9;

/**
 * Call before page.goto: routes the page's hc socket so the spec can drop it, as a relay blip does. Once the page asks to
 * re-attach after a reconnect, the host's messages wait at the route until the attach answer and the replay after it,
 * up to the first `whole` on the attached stream, have come in, and then reach the page together: the replay is handed over in
 * one go, so how the page paints it does not hang on the spacing the route's own hops put between its frames under load.
 * Later messages pass as they come.
 */
async function routeReplayInOneGo(page: Page, whole: string): Promise<{ opened: () => number; drop: () => void }> {
  const live = new Set<WebSocketRoute>();
  let connections = 0;
  await page.routeWebSocket(`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, (socket) => {
    const host = socket.connectToServer();
    let waiting: (string | Buffer)[] | null = null;
    let replayed = false;
    socket.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString("latin1");
      if (!replayed && text.includes('"resumed":true')) {
        replayed = true;
        waiting = [];
      }
      host.send(message);
    });
    connections += 1;
    let rest = Buffer.alloc(0);
    let channel: number | null = null;
    let replay = "";
    host.onMessage((message) => {
      if (waiting === null) return socket.send(message);
      waiting.push(message);
      if (typeof message === "string") return;
      rest = Buffer.concat([rest, message]);
      while (rest.byteLength >= HC_HEADER_BYTES && rest.byteLength >= HC_HEADER_BYTES + rest.readUInt32LE(5)) {
        const end = HC_HEADER_BYTES + rest.readUInt32LE(5);
        const payload = rest.subarray(HC_HEADER_BYTES, end).toString("latin1");
        const on = rest.readUInt32LE(0);
        rest = rest.subarray(end);
        const answer = /"channel":(\d+),"resize_notifications"/.exec(payload);
        if (on === 0 && answer !== null) channel = Number(answer[1]);
        else if (on === channel) replay += payload;
      }
      if (!replay.includes(whole)) return;
      for (const held of waiting) socket.send(held);
      waiting = null;
    });
    live.add(socket);
    socket.onClose(() => live.delete(socket));
  });
  return {
    opened: () => connections,
    drop: () => {
      for (const socket of live) void socket.close({ code: 1011, reason: "relay blip" });
      live.clear();
    },
  };
}

/**
 * Call before page.goto. A hidden document gets no animation frames in a browser, but headless Chromium keeps running
 * them for a page whose visibilityState a spec redefines: frames asked for while it reads "hidden" wait here until it
 * reads "visible" again, as they would.
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
      for (const [id, run] of parked) {
        parked.delete(id);
        book(id, run);
      }
    });
  });
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
      const { terminal } = await terminalFor(page);

      // Everything the program prints arrives while the app is in the background, and all of it has reached the page
      // before the app shows: the title comes behind the last line.
      const release = link.holdFromHost("");
      await page.keyboard.type(FLOOD);
      await page.keyboard.press("Enter");
      await hide(page);
      release();
      await expect(terminal).toHaveAttribute("aria-label", `${FLOOD_END} output`, { timeout: 20_000 });

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
      const link = await routeReplayInOneGo(page, `line-${LAST}`);
      const { terminal } = await terminalFor(page);
      await page.keyboard.type(FLOOD);
      await page.keyboard.press("Enter");
      await expect(terminal).toHaveAttribute("aria-label", `${FLOOD_END} output`, { timeout: 20_000 });
      await expect(terminal).toContainText(`line-${LAST}`, { timeout: 20_000 });

      await startLastLineSampler(terminal, "nothing");
      const before = link.opened();
      link.drop();
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
