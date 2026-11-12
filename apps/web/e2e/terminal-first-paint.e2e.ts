import type { Locator, Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { frameText, type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const LINES = 5_000;

/**
 * An agent's transcript as a program prints one: 5,000 lines once, then it waits. No synchronized update, so the core
 * sends the attach replay as plain output — the shape #812 measures before herdr-core brackets its first paint. Each
 * line is 37 cells, so it fits the phone's width without wrapping and the line number stays on the row the view ends
 * on.
 */
const AGENT = String.raw`
awk -v n=${LINES} 'BEGIN {
  fill = ""
  for (k = 0; k < 26; k++) fill = fill "."
  for (i = 1; i <= n; i++) printf "\033[38;5;%dmline %05d %s\033[0m%s", 240 + i % 10, i, fill, (i < n ? "\r\n" : "")
}'
exec sleep 600
`;

/** The view's last screen row shows the transcript's end: the attach replay has finished painting. */
async function atLastLine(terminal: Locator, timeout = 30_000): Promise<void> {
  await expect(terminal.locator(".term-row:not(.term-scrollback-row)").last()).toContainText(
    `line ${String(LINES).padStart(5, "0")}`,
    { timeout },
  );
}

/** The page's hc frames as text, in order: from a socket routed through the spec, or only watched as they pass. */
type HcFrames = Pick<HcSocket, "sent" | "received">;

/**
 * Watches the page's WebSocket frames as they pass, without sitting in the stream: routing the socket through the test
 * process (routeHcSocket) copies the whole attach replay on its way to the page, which a loaded runner is too slow for
 * (#2396).
 */
function watchHcFrames(page: Page): HcFrames {
  const sent: string[] = [];
  const received: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => sent.push(frameText(payload)));
    socket.on("framereceived", ({ payload }) => received.push(frameText(payload)));
  });
  return { sent: () => sent, received: () => received };
}

/** The RPC ids of the page's `terminal.attach` requests for this terminal, in the order it sent them. */
function attachIds(socket: HcFrames, address: string): number[] {
  const request = new RegExp(`"id":(\\d+),"method":"terminal\\.attach","params":\\{"terminal":"${address}"`, "g");
  return socket.sent().flatMap((text) => [...text.matchAll(request)].map((match) => Number(match[1])));
}

/** Whether hc has answered the request with this RPC id: a JSON-RPC response (a result or an error) carrying that id. */
function answered(socket: HcFrames, id: number): boolean {
  // hc puts a response's own id first ({"id":N,"jsonrpc":"2.0","result"|"error":...}), one frame each, so neither an id
  // nested in another call's result nor fields of separate frames in one message can stand in for this answer.
  const response = new RegExp(`\\{"id":${id},"jsonrpc":"2\\.0","(result|error)":`);
  return socket.received().some((text) => response.test(text));
}

interface PaintBounds {
  readonly attach: number;
  readonly answer: number;
  readonly paint: number;
}

/**
 * The attach goes out once the view has mounted and fitted, which on a starved runner is most of the wait; hc's answer
 * needs no more than the page's own deadline for a call (DEFAULT_CALL_TIMEOUT_MS, 20 s), after which the page gives up.
 */
const PAINT_BOUNDS: PaintBounds = { attach: 45_000, answer: 20_000, paint: 30_000 };

/** A test's timeout for `waits` such waits plus `rest` for everything else, so a step fails by name, not the test. */
const timeoutFor = (waits: number, rest = 30_000): number =>
  waits * (PAINT_BOUNDS.attach + PAINT_BOUNDS.answer + PAINT_BOUNDS.paint) + rest;

/**
 * Waits for the attach the page sends after `before` of them, then for hc's answer to it, then for its replay to paint
 * the transcript's end: each step on its own bound, so a loaded page that is slow to attach is waited on, while an
 * attach that is never sent or never answered still fails within the sum of the bounds (#2390). One wall-clock wait
 * from the click counted the time before the attach was even sent, which a starved renderer can spend all of.
 */
async function paintedAfterAttach(
  socket: HcFrames,
  address: string,
  terminal: Locator,
  before: number,
  bounds: PaintBounds = PAINT_BOUNDS,
): Promise<void> {
  await expect
    .poll(() => attachIds(socket, address).length, {
      message: "the page sends terminal.attach",
      timeout: bounds.attach,
    })
    .toBeGreaterThan(before);
  const id = attachIds(socket, address)[before] ?? -1;
  await expect
    .poll(() => answered(socket, id), { message: `hc answers terminal.attach #${id}`, timeout: bounds.answer })
    .toBe(true);
  await atLastLine(terminal, bounds.paint);
}

/**
 * Samples the line number of the terminal screen's bottom row after every paint until `change` is done, 0 when no
 * screen row exists (a view just mounted, or between mounts). The screen's bottom row is what the view follows as
 * output arrives, so a replay painted in slices walks its history there. A sample is read after the frame's paint, as
 * the predictive-echo specs sample one, so it is what the person saw, not a midpoint of the frame. The terminal is
 * found by its address on each frame, as a layout change can mount it anew.
 */
async function sampleBottomWhile(page: Page, address: string, change: () => Promise<void>): Promise<number[]> {
  const samples = page.evaluate(
    (selector) =>
      new Promise<number[]>((resolve) => {
        const seen: number[] = [];
        const record = (): void => {
          const element = document.querySelector(selector);
          if (element !== null) {
            const rows = element.querySelectorAll(".term-row:not(.term-scrollback-row)");
            const last = rows[rows.length - 1];
            seen.push(Number(/line (\d{5})/.exec(last?.textContent ?? "")?.[1] ?? 0));
          } else seen.push(0);
          if (document.documentElement.hasAttribute("data-e2e-stop-first-paint")) {
            document.documentElement.removeAttribute("data-e2e-stop-first-paint");
            resolve(seen);
          } else afterPaint();
        };
        // A message posted in a frame's callback is delivered once that frame is painted.
        const channel = new MessageChannel();
        channel.port1.addEventListener("message", record);
        channel.port1.start();
        const afterPaint = (): void => void requestAnimationFrame(() => channel.port2.postMessage(null));
        record();
      }),
    `[data-terminal="${address}"]`,
  );
  try {
    await change();
  } finally {
    // A change that fails still stops the sampler, so its own error is reported instead of a timeout here.
    await page.evaluate(() => document.documentElement.setAttribute("data-e2e-stop-first-paint", ""));
  }
  return samples;
}

/** Starts the transcript on the host core and lays it out in a tab of its own, returning its address. */
function startTranscript(started: string[], dir: string): string {
  const script = join(dir, "agent.sh");
  writeFileSync(script, AGENT);
  const out = hcOn("host", ["run", "--bg", "--name", "first-paint-agent", "--", "bash", script]);
  const address = String((JSON.parse(out) as { address: string }).address);
  started.push(address);
  seedLayout([{ id: "tb-812", name: "agent", root: [{ pane: "p1", terminal: address }] }]);
  return address;
}

/** Opens the page with the transcript's hc socket routed through the spec, which a test needs to hold a request. */
async function openRouted(page: Page, started: string[], dir: string) {
  const address = startTranscript(started, dir);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  return { address, socket, terminal: page.locator(`[data-terminal="${address}"]`) };
}

/**
 * Opens the page with the transcript's hc frames only watched as they pass: routing puts the test process in the
 * stream, which a loaded runner is too slow to carry the attach replay through (#2396).
 */
async function openWatched(page: Page, started: string[], dir: string) {
  const address = startTranscript(started, dir);
  const socket = watchHcFrames(page);
  await page.goto("/");
  return { address, socket, terminal: page.locator(`[data-terminal="${address}"]`) };
}

test.describe("on a phone", () => {
  test.use({ ...PHONE });

  test("a phone turned to landscape and back shows no frame with an earlier line at the bottom (#812)", async ({
    page,
  }) => {
    test.setTimeout(timeoutFor(3));
    const dir = mkdtempSync(join(tmpdir(), "doriface-first-paint-"));
    const started: string[] = [];
    try {
      const { address, socket, terminal } = await openWatched(page, started, dir);
      await page
        .getByRole("button", { name: /first-paint-agent/ })
        .first()
        .click();
      await paintedAfterAttach(socket, address, terminal, 0);

      // Each crossing of the breakpoint mounts the view anew and attaches again, so the core's first paint replays the
      // last 2,000 lines: the bottom of the view must never walk through them (#812).
      const samples = await sampleBottomWhile(page, address, async () => {
        const landscape = attachIds(socket, address).length;
        await page.setViewportSize({ width: 844, height: 390 });
        await paintedAfterAttach(socket, address, terminal, landscape);
        const portrait = attachIds(socket, address).length;
        await page.setViewportSize({ width: 390, height: 844 });
        await paintedAfterAttach(socket, address, terminal, portrait);
      });

      const earlier = samples.filter((line) => line > 0 && line < LINES);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.filter((line) => line === LINES).length, "a frame showed the transcript's end").toBeGreaterThan(0);
      expect(earlier.slice(0, 10), `${earlier.length} of ${samples.length} frames ended on an earlier line`).toEqual(
        [],
      );
    } finally {
      for (const address of started) endAgent("host", address);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an attach that is never answered still fails within its bound, not after the test's whole timeout (#2390)", async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "doriface-first-paint-"));
    const started: string[] = [];
    try {
      const { address, socket, terminal } = await openRouted(page, started, dir);
      socket.hold("terminal.attach");
      await page
        .getByRole("button", { name: /first-paint-agent/ })
        .first()
        .click();
      const bounds = { ...PAINT_BOUNDS, answer: 3_000 };
      // The held attach is still counted as sent, so the wait goes on to hc's answer, which never comes: the wait fails
      // at that step's bound, well before the old single wait's 30 s.
      const startedAt = Date.now();
      await expect(paintedAfterAttach(socket, address, terminal, 0, bounds)).rejects.toThrow(
        /hc answers terminal\.attach/,
      );
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      for (const address of started) endAgent("host", address);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
