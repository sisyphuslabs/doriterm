import type { Locator, Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent } from "./agents.ts";
import { E2E_HOST_PORT } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { seedLayout } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const LINES = 5_000;
const LAST_LINE = `line ${String(LINES).padStart(5, "0")}`;

/** 5,000 lines of 37 cells, the last one left on the cursor's row, then the program waits (as terminal-first-paint). */
const AGENT = String.raw`
awk -v n=${LINES} 'BEGIN {
  fill = ""
  for (k = 0; k < 26; k++) fill = fill "."
  for (i = 1; i <= n; i++) printf "line %05d %s%s", i, fill, (i < n ? "\r\n" : "")
}'
exec sleep 600
`;

/** hc's wire frame header: channel (u32), kind (u8), payload length (u32), little-endian; channel 0 carries the RPC. */
const HEADER_BYTES = 9;

/** The JSON-RPC message a channel-0 frame carries, or null for a stream frame. */
function rpcOf(frame: Buffer): { readonly id?: unknown; readonly method?: unknown } | null {
  if (frame.byteLength < HEADER_BYTES || frame.readUInt32LE(0) !== 0) return null;
  const message: unknown = JSON.parse(frame.subarray(HEADER_BYTES).toString("utf8"));
  return typeof message === "object" && message !== null ? message : null;
}

function framesOf(message: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; message.byteLength - at >= HEADER_BYTES;) {
    const end = at + HEADER_BYTES + message.readUInt32LE(at + 5);
    frames.push(message.subarray(at, end));
    at = end;
  }
  return frames;
}

/**
 * Call before page.goto. Once armed, the host's answer to the next `terminal.attach` the page sends waits at the route
 * until released; everything else passes in order. The core has taken that viewer on, but the page does not know its
 * stream yet, as when the answer is still on its way over a slow link.
 */
async function holdNextAttachAnswer(page: Page) {
  let armed = false;
  let held: unknown = null;
  const parked: (() => void)[] = [];
  const asked = Promise.withResolvers<void>();
  await page.routeWebSocket(`ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`, (socket) => {
    const host = socket.connectToServer();
    socket.onMessage((message) => {
      if (armed && held === null && typeof message !== "string") {
        const attach = framesOf(message)
          .map(rpcOf)
          .find((rpc) => rpc?.method === "terminal.attach");
        if (attach !== undefined) {
          held = attach?.id;
          asked.resolve();
        }
      }
      host.send(message);
    });
    host.onMessage((message) => {
      if (held === null || typeof message === "string") return socket.send(message);
      const pass: Buffer[] = [];
      for (const frame of framesOf(message)) {
        if (rpcOf(frame)?.id === held && parked.length === 0) parked.push(() => socket.send(frame));
        else pass.push(frame);
      }
      if (pass.length > 0) socket.send(Buffer.concat(pass));
    });
  });
  return {
    arm: () => void (armed = true),
    asked: () => asked.promise,
    release: () => {
      armed = false;
      for (const send of parked.splice(0)) send();
    },
  };
}

async function atLastLine(terminal: Locator): Promise<void> {
  await expect(terminal.locator(".term-row:not(.term-scrollback-row)").last()).toContainText(LAST_LINE, {
    timeout: 30_000,
  });
}

test.describe("on a phone", () => {
  test.use({ ...PHONE });

  test("a phone turned back before its landscape view's attach is answered still paints the portrait view to its bottom row (#2475)", async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "doriface-rotate-in-flight-"));
    const started: string[] = [];
    try {
      const script = join(dir, "agent.sh");
      writeFileSync(script, AGENT);
      const out = hcOn("host", ["run", "--bg", "--name", "rotate-in-flight-agent", "--", "bash", script]);
      const address = String((JSON.parse(out) as { address: string }).address);
      started.push(address);
      seedLayout([{ id: "tb-2475", name: "agent", root: [{ pane: "p1", terminal: address }] }]);
      const link = await holdNextAttachAnswer(page);
      await page.goto("/");
      await page
        .getByRole("button", { name: /rotate-in-flight-agent/ })
        .first()
        .click();
      const terminal = page.locator(`[data-terminal="${address}"]`);
      await atLastLine(terminal);

      // Landscape mounts the view anew, and its attach reaches the core; its answer waits on the way back.
      await page.evaluate(() => Reflect.set(window, "__dorifaceAttachLog", []));
      link.arm();
      await page.setViewportSize({ width: 844, height: 390 });
      await link.asked();
      // Back to portrait before that answer is in: the landscape view goes, and the portrait one starts attaching.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => (Reflect.get(window, "__dorifaceAttachLog") as unknown[]).length >= 2);
      link.release();

      await atLastLine(terminal);
    } finally {
      for (const address of started) endAgent("host", address);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
