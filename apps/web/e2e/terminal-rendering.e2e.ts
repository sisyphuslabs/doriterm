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

for (const type of ["foreground", "title"] as const) {
  test(`${type} in one of three panes paints next frame without rendering the shell (#2607)`, async ({ page }) => {
    await page.addInitScript(() => {
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
      Object.defineProperty(MessageEvent.prototype, "data", {
        configurable: true,
        get(this: MessageEvent): unknown {
          const value: unknown = data.call(this);
          if (!(value instanceof ArrayBuffer) || heard.has(this)) return value;
          heard.add(this);
          const marker = /render-proof-\d+/.exec(new TextDecoder().decode(value))?.[0];
          if (marker !== undefined) {
            armed = true;
            requestAnimationFrame(() => {
              painted.push([...document.querySelectorAll("h2")].some((node) => node.textContent === marker));
              armed = false;
            });
          }
          return value;
        },
      });
    });
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
                `${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { seq: 1_000_000 + i, type, terminal: address, data } })}\n`,
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
    console.log(`${type} render evidence ${JSON.stringify(evidence)}`);
    expect(evidence.painted).toEqual(Array.from({ length: 6 }, () => true));
    expect(evidence.runs.length).toBeGreaterThanOrEqual(6);
    // What shows the terminal runs and nothing else: its pane (about 23 components) and its sidebar row with the row's
    // labelled actions (about 39), against about 550 when the whole shell ran (#2607).
    expect(Math.max(...evidence.runs)).toBeLessThanOrEqual(80);
  });
}
