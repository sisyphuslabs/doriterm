import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_RELAY } from "./capture-relay.ts";
import { pressNewTab } from "./fixtures.ts";
import { fakeSoftKeyboard, key } from "./phone-key-bar.ts";
import { routeRelaySockets } from "./relay-route.ts";

/** A real doriface-host and hc core behind the private relay under wrangler dev (web-relay-host.ts). */
export interface RelayHost {
  readonly relayUrl: string;
  /** A fresh pairing link's fragment (`#h=...`): the host keeps one offer open at a time, so ask just before pairing. */
  readonly pairingFragment: () => Promise<string>;
  readonly stop: () => Promise<void>;
}

const HELPER = join(import.meta.dirname, "..", "..", "..", "tests", "relay", "support", "web-relay-host.ts");

/**
 * Starts web-relay-host.ts and waits for its `READY {relayUrl}` line, as terminal-links-relay.e2e.ts does. It needs a
 * relay checkout (DORIFACE_RELAY_DIR): call it only from a spec skipped without one.
 */
export async function startRelayHost(): Promise<RelayHost> {
  // Playwright sets FORCE_COLOR for its workers; wrangler would colour the line the helper waits for.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  const helper = spawn("bun", [HELPER], { stdio: ["pipe", "pipe", "inherit"], env: { ...inherited, NO_COLOR: "1" } });
  if (helper.stdout === null) throw new Error("relay-host has no stdout");
  const reader = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  /** The next line the helper prints that starts with `prefix`, without the prefix; other lines are skipped. */
  const nextLine = async (prefix: string): Promise<string> => {
    const next = await reader.next();
    if (next.done === true) throw new Error(`relay-host ended before a ${prefix.trim()} line`);
    return next.value.startsWith(prefix) ? next.value.slice(prefix.length) : nextLine(prefix);
  };
  const { relayUrl } = JSON.parse(await nextLine("READY ")) as { readonly relayUrl: string };
  return {
    relayUrl,
    pairingFragment: () => {
      helper.stdin?.write("PAIR\n");
      return nextLine("LINK ");
    },
    async stop() {
      helper.kill("SIGTERM");
      await expect.poll(() => helper.exitCode ?? helper.signalCode, { timeout: 60_000 }).not.toBeNull();
    },
  };
}

/**
 * Carries the page's relay client sockets to `host` with a round trip added: every frame, both ways, is delivered
 * `rttMs / 2` (plus a uniform 0..`jitterMs`) after it was sent, and never before the frame sent ahead of it, so the
 * order is the relay's. The local relay's own round trip is under a millisecond (docs/architecture.md §5), so this is
 * what makes it slow. Registered after `routeRelaySockets`, it carries those sockets in its place (Playwright uses the
 * last route that matches); the pairing lookup stays with `routeRelaySockets`.
 */
export async function delayRelaySockets(
  page: Page,
  host: RelayHost,
  { rttMs, jitterMs = 0 }: { readonly rttMs: number; readonly jitterMs?: number },
): Promise<void> {
  const base = host.relayUrl.replace(/\/+$/, "");
  /** One direction's queue: each delivery is due a half round trip after it was sent, and not before the last one. */
  const oneWay = (): ((deliver: () => void) => void) => {
    let lastDue = 0;
    return (deliver) => {
      lastDue = Math.max(Date.now() + rttMs / 2 + Math.random() * jitterMs, lastDue);
      setTimeout(deliver, Math.max(0, lastDue - Date.now()));
    };
  };
  // Any port: a session's second and third sockets dial the relay's other HTTPS ports (#1418).
  await page.routeWebSocket(new RegExp(`^${FAKE_RELAY.replaceAll(".", "\\.")}(:\\d+)?/v1/client/`), (socket) => {
    const target = new URL(socket.url());
    const relay = new WebSocket(`${base}${target.pathname}${target.search}`);
    relay.binaryType = "arraybuffer";
    const toRelay = oneWay();
    const toPage = oneWay();
    const early: (string | Uint8Array<ArrayBuffer>)[] = [];
    relay.addEventListener("open", () => {
      for (const frame of early.splice(0)) relay.send(frame);
    });
    socket.onMessage((message) => {
      const frame = typeof message === "string" ? message : Uint8Array.from(message);
      toRelay(() => {
        if (relay.readyState === WebSocket.OPEN) relay.send(frame);
        else if (relay.readyState === WebSocket.CONNECTING) early.push(frame);
      });
    });
    relay.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      const frame = typeof event.data === "string" ? event.data : Buffer.from(event.data);
      toPage(() => socket.send(frame));
    });
    relay.addEventListener("close", (event) => {
      toPage(() => void socket.close({ code: event.code, reason: event.reason }));
    });
    socket.onClose(() => toRelay(() => relay.close()));
  });
}

/**
 * Pairs `page` with `host` by its link, as a person would, over a link with `rttMs` (and `jitterMs`) added, then opens a
 * terminal: the desktop tab strip's New tab, or on a phone the header's with its keyboard shown (as openPhoneTerminal
 * does). Call before the page has loaded anything.
 */
export async function pairAndOpenTerminal(
  page: Page,
  host: RelayHost,
  { phone, rttMs = 0, jitterMs = 0 }: { readonly phone: boolean; readonly rttMs?: number; readonly jitterMs?: number },
): Promise<Locator> {
  if (phone) await fakeSoftKeyboard(page);
  // Pairing dials the link's relay; the workspace then dials the production one, as every release build does (#452).
  await routeRelaySockets(page, host.relayUrl);
  await delayRelaySockets(page, host, { rttMs, jitterMs });
  await page.goto(`/pair${await host.pairingFragment()}`);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByText("This device now reaches the host through the relay")).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click();
  const newTab = phone
    ? page.getByRole("banner").getByRole("button", { name: "New tab" })
    : page.getByRole("button", { name: "New tab", exact: true });
  // "+" opens the new-item menu since #548; pressNewTab picks its Terminal item (the phone header's starts one at once).
  await pressNewTab(newTab, { timeout: 60_000 });
  const terminal = page.locator("[data-terminal]").last();
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  // A phone raises its keyboard only when the keys ask for it (#1375).
  if (phone) await key(page, "Show keyboard").click();
  return terminal;
}
