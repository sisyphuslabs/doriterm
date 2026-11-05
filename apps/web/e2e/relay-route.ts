import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { expect, type Page } from "@playwright/test";
import { FAKE_RELAY } from "./capture-relay.ts";
import { E2E_WEB_PORT } from "./config.ts";

/**
 * A host across the network, reached the way a phone or laptop reaches one: through the relay, end to end encrypted.
 * fake-relay-host.ts runs it on a FakeRelay; `route` carries the page's relay sockets there.
 */
export interface FakeRelayHost {
  /** A fresh pairing link: each one pairs one device, once. */
  readonly pairingLink: () => Promise<string>;
  /** Call before the page dials the relay: its `/v1/client/...` sockets go to the fake relay's client bridge. */
  readonly route: (page: Page) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * Carries the page's sockets on the production relay address (the only relay a release build dials, #389) to the relay
 * at `toRelay` instead, path and query kept. The e2e web server is a release build, so this is how a spec reaches a
 * test relay without the page knowing it is not the production one.
 */
export async function routeRelaySockets(page: Page, toRelay: string): Promise<void> {
  const base = toRelay.replace(/\/+$/, "");
  await page.routeWebSocket(new RegExp(`^${FAKE_RELAY.replaceAll(".", "\\.")}/v1/client/`), (socket) => {
    const target = new URL(socket.url());
    const relay = new WebSocket(`${base}${target.pathname}${target.search}`);
    relay.binaryType = "arraybuffer";
    const early: (string | Uint8Array<ArrayBuffer>)[] = [];
    relay.addEventListener("open", () => {
      for (const frame of early.splice(0)) relay.send(frame);
    });
    socket.onMessage((message) => {
      const frame = typeof message === "string" ? message : Uint8Array.from(message);
      if (relay.readyState === WebSocket.OPEN) relay.send(frame);
      else early.push(frame);
    });
    relay.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) =>
      socket.send(typeof event.data === "string" ? event.data : Buffer.from(event.data)),
    );
    relay.addEventListener("close", (event) => void socket.close({ code: event.code, reason: event.reason }));
    socket.onClose(() => relay.close());
  });
}

/** `machine`: the host's core also has an added machine (the sidebar then lists machines with their state). */
export async function startFakeRelayHost(options: { readonly machine?: boolean } = {}): Promise<FakeRelayHost> {
  const script = join(import.meta.dirname, "fake-relay-host.ts");
  const driver: ChildProcess = spawn(
    "bun",
    [script, `http://127.0.0.1:${E2E_WEB_PORT}`, FAKE_RELAY, ...(options.machine === true ? ["--machine"] : [])],
    {
      cwd: join(import.meta.dirname, ".."),
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const out = driver.stdout;
  const input = driver.stdin;
  if (out === null || input === null) throw new Error("the fake relay host has no stdio");
  const lines: Interface = createInterface({ input: out });
  const waiting: ((value: Record<string, unknown>) => void)[] = [];
  const queued: Record<string, unknown>[] = [];
  void (async () => {
    for await (const line of lines) {
      if (!line.startsWith("{")) continue;
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      const next = waiting.shift();
      if (next === undefined) queued.push(parsed as Record<string, unknown>);
      else next(parsed as Record<string, unknown>);
    }
  })();
  const nextLine = (): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const ready = queued.shift();
      if (ready === undefined) waiting.push(resolve);
      else resolve(ready);
    });
  const first = await nextLine();
  const bridge = first["bridge"];
  if (typeof bridge !== "string") throw new Error("the fake relay host printed no bridge");

  return {
    async pairingLink() {
      input.write("link\n");
      const { link } = await nextLine();
      if (typeof link !== "string") throw new Error("the fake relay host printed no pairing link");
      return link;
    },
    route: (page) => routeRelaySockets(page, bridge),
    async stop() {
      if (driver.exitCode !== null) return;
      input.end();
      driver.kill("SIGTERM");
      // It stops the host, its core and the relay before it exits.
      await expect.poll(() => driver.exitCode ?? driver.signalCode, { timeout: 60_000 }).not.toBeNull();
    },
  };
}
