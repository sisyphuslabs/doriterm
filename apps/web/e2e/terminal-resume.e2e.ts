import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, type RelayObserver, startFakeRelayHost } from "./relay-route.ts";

// A relay blip no longer replays the terminal (#1995, contract v1.11 "Session resume"): the session is carried on over a
// new socket, so a reconnect with nothing new exchanges one request and one answer, attaches nothing, and leaves the
// rows, the scroll position and the frames as they were. Output the host produced while the socket was down arrives as
// the records the page missed, appended where they belong, once.
test.use({ serviceWorkers: "block" });

const SETTINGS_KEY = "doriface.connection";
/** The resume request and its answer, in bytes (contract v1.11): the only two messages an idle reconnect needs. */
const REQUEST_BYTES = 57;
const ANSWER_BYTES = 41;
/** The smallest attach replay is one screen (13 KB measured in #639); a heartbeat record is well under this. */
const REPLAY_FLOOR_BYTES = 1024;

interface Traffic {
  readonly toRelay: number[];
  readonly fromRelay: number[];
}

interface Sockets {
  readonly traffic: Traffic;
  /** Where the traffic counts stood as each socket opened, in order: a socket's messages are the ones after its mark. */
  readonly opened: { readonly toRelay: number; readonly fromRelay: number }[];
  /** Closes every socket the page has open, as a relay blip does; sockets opened while `down` are dropped at once. */
  readonly drop: () => void;
  down: boolean;
}

function observe(): { readonly observer: RelayObserver; readonly sockets: Sockets } {
  const traffic: Traffic = { toRelay: [], fromRelay: [] };
  const open = new Set<{ readonly drop: (code: number, reason: string) => void }>();
  const sockets: Sockets = {
    traffic,
    opened: [],
    down: false,
    drop: () => {
      for (const socket of open) socket.drop(4008, "blip");
      open.clear();
    },
  };
  const observer: RelayObserver = {
    toRelay: (bytes) => traffic.toRelay.push(bytes),
    fromRelay: (bytes) => traffic.fromRelay.push(bytes),
    opened: (socket) => {
      if (sockets.down) return socket.drop(4008, "still down");
      sockets.opened.push({ toRelay: traffic.toRelay.length, fromRelay: traffic.fromRelay.length });
      open.add(socket);
    },
  };
  return { observer, sockets };
}

async function pairAndOpen(page: Page, host: FakeRelayHost): Promise<Locator> {
  const link = await host.pairingLink();
  await page.goto(link);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click({ timeout: 30_000 });
  if ((await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY)) === null)
    throw new Error("pairing saved no connection");
  const terminal = page.locator("[data-terminal]").first();
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  return terminal;
}

/** What the reader has in front of them: the terminal's DOM, where it is scrolled, and how often it attached. */
const snapshot = (terminal: Locator) =>
  terminal.evaluate((element) => ({
    nodes: element.querySelectorAll("*").length,
    pageNodes: document.querySelectorAll("*").length,
    rows: element.querySelectorAll(".term-row").length,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    attaches: (Reflect.get(globalThis, "__dorifaceAttachLog") as unknown[] | undefined)?.length ?? 0,
  }));

/** How many rows the terminal has rendered: the screen, and the window of history a reader scrolled up is shown. */
const renderedRows = (terminal: Locator) =>
  terminal.evaluate((element) => element.querySelectorAll(".term-row").length);

/** Samples every animation frame from now until `stop`, as the page paints them. */
const sampleFrames = (page: Page) =>
  page.evaluate(() => {
    const times: number[] = [];
    let on = true;
    const tick = (time: number): void => {
      times.push(time);
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Reflect.set(globalThis, "__resumeFrames", { times, stop: () => void (on = false) });
  });

const framesSampled = (page: Page) =>
  page.evaluate(() => {
    const sampler = Reflect.get(globalThis, "__resumeFrames") as { times: number[]; stop: () => void };
    sampler.stop();
    const gaps = sampler.times.slice(1).map((time, index) => time - (sampler.times[index] ?? time));
    return {
      frames: sampler.times.length,
      maxGapMs: Math.max(0, ...gaps),
      meanGapMs: gaps.length === 0 ? 0 : gaps.reduce((a, b) => a + b, 0) / gaps.length,
    };
  });

test("a relay blip with nothing new is one request and one answer: no attach, the same rows, the same scroll, no replay", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.set(globalThis, "__dorifaceAttachLog", []);
    Reflect.set(globalThis, "__dorifaceRpcLog", []);
  });
  const rpcs = () => page.evaluate(() => (Reflect.get(globalThis, "__dorifaceRpcLog") as string[]).length);
  const { observer, sockets } = observe();
  const host = await startFakeRelayHost({ terminal: true });
  let gateDir: string | undefined;
  try {
    await host.route(page, observer);
    const terminal = await pairAndOpen(page, host);
    await terminal.getByRole("textbox").focus();
    await page.keyboard.type("seq -f 'line-%g' 1 400");
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("line-400", { timeout: 30_000 });
    // The screen alone, before the reader goes up: the rows a scroll into history then adds are what settles below.
    const screenRows = await renderedRows(terminal);
    // A reader up in history, so a scroll that moved would show.
    await terminal.evaluate((element) => {
      element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
    });
    await expect.poll(() => terminal.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    // The scroll renders its window of history a frame later than scrollTop reads back. The snapshot waits for those
    // rows, so the comparison after the blip measures the resume, not whether a frame fell between scroll and snapshot.
    await expect.poll(() => renderedRows(terminal)).toBeGreaterThan(screenRows);
    const before = await snapshot(terminal);
    expect(before.attaches).toBeGreaterThanOrEqual(1);
    expect(before.scrollTop).toBeGreaterThan(0);
    // The page keeps talking on the old socket until it drops (a heartbeat, a key exchange), so the resume is measured
    // on the socket that opens after the blip, from the counts as it opened (#2482).
    const socketsBefore = sockets.opened.length;
    const rpcsBefore = await rpcs();

    await sampleFrames(page);
    const droppedAt = Date.now();
    sockets.drop();
    // The resume: one request out, one answer back, on the new socket.
    const resumed = () => sockets.opened[socketsBefore];
    await expect
      .poll(
        () => {
          const mark = resumed();
          return mark === undefined ? 0 : sockets.traffic.fromRelay.length - mark.fromRelay;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeHidden({ timeout: 20_000 });
    const resumedAfterMs = Date.now() - droppedAt;
    // Anything a replay would add arrives within a settle; a heartbeat may land too, far under a replay's size.
    await page.waitForTimeout(1_000);
    const frames = await framesSampled(page);
    const after = await snapshot(terminal);
    const mark = resumed();
    if (mark === undefined) throw new Error("no socket opened after the blip");
    const sent = sockets.traffic.toRelay.slice(mark.toRelay);
    const received = sockets.traffic.fromRelay.slice(mark.fromRelay);
    const calls = await page.evaluate(
      (from) => (Reflect.get(globalThis, "__dorifaceRpcLog") as string[]).slice(from),
      rpcsBefore,
    );
    const measured = { before, after, sent, received, calls, resumedAfterMs, frames };
    test.info().annotations.push({ type: "measured", description: JSON.stringify(measured) });
    console.log(`idle reconnect: ${JSON.stringify(measured)}`);

    expect(sent[0]).toBe(REQUEST_BYTES);
    expect(received[0]).toBe(ANSWER_BYTES);
    // Nothing of the terminal is asked again: no attach, and no screen-sized message either way.
    expect(calls).not.toContain("terminal.attach");
    for (const bytes of sent.slice(1)) expect(bytes).toBeLessThan(REPLAY_FLOOR_BYTES);
    for (const bytes of received.slice(1)) expect(bytes).toBeLessThan(REPLAY_FLOOR_BYTES);
    expect(after.attaches).toBe(before.attaches);
    expect(after.nodes).toBe(before.nodes);
    expect(after.rows).toBe(before.rows);
    expect(after.scrollTop).toBe(before.scrollTop);
    expect(after.scrollHeight).toBe(before.scrollHeight);
    expect(frames.frames).toBeGreaterThan(10);

    // Output the host makes while the socket is down comes as the records the page missed, appended once, with the
    // reader left where they were.
    // The output waits for a file the test makes once the socket is down, so it is made during the outage however slow
    // the runner is; a fixed sleep let it land before the drop under load (#2482).
    gateDir = mkdtempSync(join(tmpdir(), "resume-"));
    const go = join(gateDir, "go");
    await page.keyboard.type(`until [ -e '${go}' ]; do sleep 0.1; done; seq -f 'late-%g' 1 20`);
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText("seq -f 'late-%g' 1 20");
    // Typing follows the output to the end; the reader then goes back up, and must be left there by what arrives.
    await terminal.evaluate((element) => {
      element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
    });
    await expect
      .poll(() => terminal.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeGreaterThan(100);
    const idle = await snapshot(terminal);
    const sentIdle = sockets.traffic.toRelay.length;
    const receivedIdle = sockets.traffic.fromRelay.length;
    sockets.down = true;
    sockets.drop();
    writeFileSync(go, "");
    await page.waitForTimeout(2_500);
    sockets.down = false;
    await expect(terminal).toContainText("late-20", { timeout: 30_000 });
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(500);
    const caughtUp = await snapshot(terminal);
    const text = (await terminal.textContent()) ?? "";
    const missed = {
      idle,
      caughtUp,
      sent: sockets.traffic.toRelay.slice(sentIdle),
      received: sockets.traffic.fromRelay.slice(receivedIdle),
    };
    test.info().annotations.push({ type: "measured-missed", description: JSON.stringify(missed) });
    console.log(`reconnect with missed output: ${JSON.stringify(missed)}`);
    expect(caughtUp.attaches).toBe(idle.attaches);
    expect(text.match(/late-20/g)).toHaveLength(1);
    expect(text.match(/late-1\b/g)).toHaveLength(1);
    expect(text.match(/line-400/g)).toHaveLength(1);
    // The rows that arrived went below a reader who was up in history, who did not move.
    expect(caughtUp.scrollTop).toBe(idle.scrollTop);
    expect(caughtUp.scrollHeight).toBeGreaterThan(idle.scrollHeight);
    expect(missed.sent.filter((bytes) => bytes === REQUEST_BYTES).length).toBeGreaterThanOrEqual(1);
    for (const bytes of missed.received) expect(bytes).toBeLessThan(13_000);
  } finally {
    if (gateDir !== undefined) rmSync(gateDir, { recursive: true, force: true });
    await host.stop();
  }
});
