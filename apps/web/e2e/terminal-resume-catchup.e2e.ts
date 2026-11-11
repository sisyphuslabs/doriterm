import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { E2E_HOST_PORT } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { hiddenDocumentFrames, hide, sampledFrames, startLastLineSampler, transitions } from "./resume-probe.ts";

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
 * The flood again, its last 2,100 lines each in two dozen colors, in under 40 columns so a line fits a phone's row
 * unwrapped, while the lines before them stay plain and quick to print. Since #1999 a reattach to a painted view asks for
 * no history (`history: 0`), so what the core sends back after a reconnect is the screen's repaint alone: some 10-20 KB,
 * not the 2,000 colored lines of history. The hold tests that use it therefore cover a screen repaint over a slow link,
 * not a multi-MiB replay (#2032).
 */
const COLORED_FLOOD = `c=$(for k in $(seq 1 24); do printf '\\033[38;5;%d;48;5;%dmx' $((k*9)) $((255-k*9)); done); for i in $(seq 1 ${LAST}); do if [ $i -gt ${LAST - 2100} ]; then echo "line-$i $c"; else echo line-$i; fi; done; printf '\\033[0m\\033]2;${FLOOD_END}\\007'`;

/**
 * Watches the frames a routed hc socket delivers on the stream channels: how many bytes came after `since()` turned on
 * and in how many windows, a window being a run of frames with less than half a round trip between them.
 */
function streamArrivals(rttMs: number) {
  let on = false;
  let bytes = 0;
  let windows = 0;
  let last = -Infinity;
  return {
    received: (frame: string): void => {
      if (!on || frame.length < HC_HEADER_BYTES || Buffer.from(frame.slice(0, 4), "latin1").readUInt32LE(0) === 0)
        return;
      const now = Date.now();
      if (now - last > rttMs / 2) windows += 1;
      last = now;
      bytes += frame.length - HC_HEADER_BYTES;
    },
    since: (): void => {
      on = true;
    },
    bytes: (): number => bytes,
    report: (): string => `${windows} windows, ${bytes} bytes`,
  };
}

/** hc's credit window: the core sends this much of a stream and waits for its credit to come back. */
const CREDIT_WINDOW_BYTES = 256 * 1024;

/**
 * Call before the page loads: samples, in every painted frame from the load on, the highest line number on the grid of
 * the terminal at `address` (0 while it shows none), as startLastLineSampler does for a terminal already on screen.
 * sampledFrames stops it and returns the samples.
 */
function sampleFromLoad(address: string): void {
  const samples: number[] = [];
  let on = true;
  let frame = 0;
  const sample = (): void => {
    let last = 0;
    for (const row of document.querySelectorAll(
      `[data-terminal="${address}"] .term-grid .term-row:not(.term-scrollback-row)`,
    ))
      for (const match of (row.textContent ?? "").matchAll(/line-(\d+)/g)) last = Math.max(last, Number(match[1]));
    samples.push(last);
  };
  Reflect.set(window, "__lastLines", () => {
    on = false;
    return samples;
  });
  const start = (): void => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10px;top:-10px;height:1px;pointer-events:none";
    document.body.appendChild(probe);
    new ResizeObserver(() => {
      if (on) sample();
    }).observe(probe);
    const tick = (): void => {
      frame += 1;
      probe.style.width = `${1 + (frame % 2)}px`;
      if (on) requestAnimationFrame(tick);
      else probe.remove();
    };
    requestAnimationFrame(tick);
  };
  if (document.body === null) document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

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
      await hiddenDocumentFrames(page, "/v1/hc");
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

    for (const rttMs of [150, 300])
      test(`over a ${rttMs} ms relay, a reconnect's replay that comes a slice a round trip is painted once it has settled: the screen never climbs back (D5, #1040)`, async ({
        page,
      }) => {
        // A flood of a few MiB, painted, then a reconnect's replay a window a round trip. Since #1999 that replay is the
        // screen's repaint alone, some 20 KB in a few windows; a replay of the history across many windows is the next
        // test's. The flood is more than the default budget on a loaded runner, though every wait is on a marker.
        test.slow();
        await page.addInitScript(() => {
          Reflect.set(window, "__dorifaceAttachLog", []);
        });
        const arrivals = streamArrivals(rttMs);
        const link = await routeHcSocket(page, { received: arrivals.received });
        const { terminal } = await terminalFor(page);
        await page.keyboard.type(COLORED_FLOOD);
        await page.keyboard.press("Enter");
        await expect(terminal).toHaveAttribute("aria-label", `${FLOOD_END} output`, { timeout: 60_000 });
        await expect(terminal).toContainText(`line-${LAST}`, { timeout: 60_000 });

        await startLastLineSampler(terminal, "nothing");
        // From the drop on, every frame from the host comes a round trip late: the new connection measures that SRTT, and
        // the core, which sends one 256 KiB credit window and waits for its credit, hands the replay over a window a round
        // trip, as the relay does.
        link.delay(rttMs);
        const before = link.opened();
        arrivals.since();
        await link.drop(true);
        link.restore();
        await expect.poll(link.opened, { timeout: 15_000 }).toBeGreaterThan(before);
        await expect
          .poll(() => page.evaluate(() => (Reflect.get(window, "__dorifaceAttachLog") as unknown[]).length))
          .toBeGreaterThanOrEqual(2);
        // Output after the replay marks the replay as delivered and painted: it comes behind the replay's last slice.
        await page.keyboard.type("echo done-$((1+1))");
        await page.keyboard.press("Enter");
        await expect(terminal).toContainText("done-2", { timeout: 30_000 });
        const frames = await sampledFrames(page);
        console.log(`spaced ${device} ${rttMs}: the replay came in ${arrivals.report()}`);

        expect(frames.length).toBeGreaterThan(0);
        expect(frames.at(-1)).toBe(LAST);
        // The old screen stays until the replay is drawn whole: at most one change, never an empty or climbing screen.
        expect(transitions(frames)).toBeLessThanOrEqual(1);
        expect(frames.filter((last) => last !== LAST)).toEqual([]);
      });

    for (const slowdown of [1, 10])
      test(`over a 300 ms relay, an attach that replays the terminal's history, a window a round trip, is painted once it has settled${slowdown > 1 ? ` on a page ${slowdown}x slower` : ""}: the screen never climbs (D5, #2011, #2242, #2271)`, async ({
        page,
      }) => {
        // A flood of a few MiB, painted, then a replay of over a MiB a window a round trip: more than the default budget on
        // a loaded runner, though every wait is on a marker.
        test.slow();
        const rttMs = 300;
        const arrivals = streamArrivals(rttMs);
        const link = await routeHcSocket(page, { received: arrivals.received });
        const { terminal, address } = await terminalFor(page);
        await page.keyboard.type(COLORED_FLOOD);
        await page.keyboard.press("Enter");
        await expect(terminal).toHaveAttribute("aria-label", `${FLOOD_END} output`, { timeout: 60_000 });
        await expect(terminal).toContainText(`line-${LAST}`, { timeout: 60_000 });

        // A reload mounts the terminal again, a view this page has never painted, so its attach asks the core for the
        // history too: the 2,000 colored lines, which the core hands over a credit window a round trip. Every frame from
        // the host comes a round trip late, so the new connection measures that SRTT, as over the relay.
        await page.addInitScript(sampleFromLoad, address);
        // A slow page (a phone, a starved tab) takes each window in about as long as a span of the hold's cap, so a span's
        // ends can cut a window anywhere (#2271). Chromium keeps the throttle across the reload.
        if (slowdown > 1)
          await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: slowdown });
        link.delay(rttMs);
        arrivals.since();
        await page.reload();
        await expect(page.locator(`[data-terminal="${address}"]`)).toContainText(`line-${LAST}`, { timeout: 60_000 });
        const frames = await sampledFrames(page);
        console.log(`history ${device} ${rttMs} ${slowdown}x: the replay came in ${arrivals.report()}`);

        // The replay this test is for: the history, over many windows, not a screen's repaint.
        expect(arrivals.bytes()).toBeGreaterThan(4 * CREDIT_WINDOW_BYTES);
        expect(frames.at(-1)).toBe(LAST);
        // The empty screen stays until the replay is drawn whole: one change, never a screen that climbs toward the end.
        expect(transitions(frames)).toBeLessThanOrEqual(1);
        expect(frames.filter((last) => last !== 0 && last !== LAST)).toEqual([]);
      });
  });
}
