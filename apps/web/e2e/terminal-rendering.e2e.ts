import { encodeFrame, FrameKind, isJsonObject } from "@doriface/protocol";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

interface Fiber {
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly flags: number;
  readonly tag: number;
}

/**
 * Counts, in the page, the React components that run in each commit from the moment a message carrying a
 * `render-proof-N` marker arrives until `frames` animation frames later, and notes whether an element matching
 * `shownIn` then reads the marker. A bailed-out subtree keeps its fibers and their old flags, so only fibers new in a
 * commit count as having run.
 */
function countRenders([frames, shownIn]: readonly [frames: number, shownIn: string]): void {
  const counts: number[] = [];
  const freshCounts: number[] = [];
  const painted: boolean[] = [];
  Reflect.set(window, "__terminalRuns", counts);
  Reflect.set(window, "__terminalFreshRuns", freshCounts);
  Reflect.set(window, "__terminalPainted", painted);
  let armed = false;
  // A bailed-out subtree keeps its fibers and old PerformedWork flags; those functions did not run again.
  let previous = new WeakSet<Fiber>();
  let current = new WeakSet<Fiber>();
  let fresh = 0;
  const walk = (fiber: Fiber | null): number => {
    let count = 0;
    for (let f = fiber; f !== null; f = f.sibling) {
      current.add(f);
      if ([0, 11, 14, 15].includes(f.tag) && (f.flags & 1) !== 0) {
        count += 1;
        if (!previous.has(f)) fresh += 1;
      }
      count += walk(f.child);
    }
    return count;
  };
  Reflect.set(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      current = new WeakSet<Fiber>();
      fresh = 0;
      const ran = walk(root.current.child);
      previous = current;
      if (armed) {
        counts.push(ran);
        freshCounts.push(fresh);
      }
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    checkDCE: () => undefined,
  });
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
  if (data === undefined) throw new Error("MessageEvent.data is unavailable");
  const heard = new WeakSet<MessageEvent>();
  // A marker opens its window once, with the first message that carries it.
  const marked = new Set<string>();
  Object.defineProperty(MessageEvent.prototype, "data", {
    configurable: true,
    get(this: MessageEvent): unknown {
      const value: unknown = data.call(this);
      if (!(value instanceof ArrayBuffer) || heard.has(this)) return value;
      heard.add(this);
      const marker = /render-proof-\d+/.exec(new TextDecoder().decode(value))?.[0];
      if (marker !== undefined && !marked.has(marker)) {
        marked.add(marker);
        armed = true;
        const close = (left: number): void => {
          if (left > 0) return void requestAnimationFrame(() => close(left - 1));
          painted.push([...document.querySelectorAll(shownIn)].some((node) => node.textContent?.trim() === marker));
          armed = false;
        };
        close(frames);
      }
      return value;
    },
  });
}

for (const type of ["foreground", "title"] as const) {
  test(`${type} in one of three panes paints next frame without rendering the shell (#2607)`, async ({ page }) => {
    await page.addInitScript(countRenders, [1, "h2"] as const);
    const socket = await routeHcSocket(page);
    await page.goto("/");
    const first = await openNewTerminal(page);
    const address = await first.getAttribute("data-terminal");
    expect(address).not.toBeNull();
    for (let i = 0; i < 2; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each split adds to the pane the last one made
      await page.getByRole("button", { name: "Split right", exact: true }).first().click();
      // oxlint-disable-next-line no-await-in-loop -- as above
      await expect(page.locator("[data-terminal]")).toHaveCount(i + 2);
    }
    await expect(page.locator("[data-terminal]")).toHaveCount(3);
    await page.locator("[data-terminal]").last().getByRole("textbox").focus();
    const channels = new Set<number>();
    let cwd: string | undefined;
    for (const frame of socket.received()) {
      const payload = frame.slice(9).split("\n")[0]?.trim() ?? "";
      if (!payload.startsWith("{")) continue;
      const reply: unknown = JSON.parse(payload);
      const result = isJsonObject(reply) ? reply["result"] : undefined;
      if (isJsonObject(result) && typeof result["channel"] === "number" && "seq" in result)
        channels.add(result["channel"]);
      const params = isJsonObject(reply) ? reply["params"] : undefined;
      const data = isJsonObject(params) ? params["data"] : undefined;
      if (
        isJsonObject(params) &&
        params["terminal"] === address &&
        isJsonObject(data) &&
        typeof data["cwd"] === "string"
      )
        cwd = data["cwd"];
    }
    expect(channels.size).toBe(1);
    expect(cwd).toBeDefined();
    socket.holdFromHost('"method":"event"');
    // The roster's ten-second machine read draws the workspace again whether or not anything changed; one landing in a
    // frame this test counts would be charged to the event. It is not sent until the events are counted.
    const release = socket.hold("machine.list");
    for (let i = 0; i < 6; i += 1) {
      const marker = `render-proof-${i}`;
      const data = type === "title" ? { title: marker } : { pid: 123 + i, name: marker, argv: [marker], cwd };
      for (const channel of channels) {
        socket.sendFromHost(
          Buffer.from(
            encodeFrame(
              channel,
              FrameKind.Data,
              new TextEncoder().encode(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  method: "event",
                  params: { seq: 1_000_000 + i, type, terminal: address, data },
                })}\n`,
              ),
            ),
          ),
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- each event is painted before the next one is sent
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "__terminalPainted").length)).toBe(i + 1);
    }
    const evidence = await page.evaluate(() => ({
      painted: Reflect.get(window, "__terminalPainted"),
      retainedFlags: Reflect.get(window, "__terminalRuns"),
      runs: Reflect.get(window, "__terminalFreshRuns"),
    }));
    release();
    console.log(`${type} render evidence ${JSON.stringify(evidence)}`);
    expect(evidence.painted).toEqual(Array.from({ length: 6 }, () => true));
    expect(evidence.runs.length).toBeGreaterThanOrEqual(6);
    // What shows the terminal runs and nothing else: its pane (about 23 components) and its sidebar row with the row's
    // labelled actions (about 39), against about 550 when the whole shell ran (#2607).
    expect(Math.max(...evidence.runs)).toBeLessThanOrEqual(80);
  });
}

// A terminal's output is written and drawn by wterm outside React. What React draws of it is the scrollbar and the
// jump-to-bottom button; the terminal's own view, with its dialogs and menus, has nothing to draw again (#2607).
test("a terminal's output runs only the components that read its scroll position (#2607)", async ({ page }) => {
  // Output is drawn the frame after it is written, and the scroll position is read the frame after that.
  await page.addInitScript(countRenders, [4, ".term-row"] as const);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  // No process, title or status event reaches the page meanwhile, and the roster's ten-second machine read, which
  // draws the workspace again, is not sent: only the terminal's own output arrives.
  socket.holdFromHost('"method":"event"');
  const release = socket.hold("machine.list");
  const LINES = 6;
  await page.keyboard.type(`for i in $(seq 1 ${LINES}); do sleep 0.3; echo render-proof-$i; done`);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__terminalPainted").length), { timeout: 20_000 })
    .toBe(LINES);
  const evidence = await page.evaluate(() => ({
    painted: Reflect.get(window, "__terminalPainted"),
    runs: Reflect.get(window, "__terminalFreshRuns"),
  }));
  release();
  console.log(`output render evidence ${JSON.stringify(evidence)}`);
  expect(evidence.painted).toEqual(Array.from({ length: LINES }, () => true));
  // The scrollbar and the jump button run, each a component or two; the view around them ran twelve (#2607).
  expect(Math.max(0, ...evidence.runs)).toBeLessThanOrEqual(4);
});
