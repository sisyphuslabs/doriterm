import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { appDir } from "./launch.ts";
import { RUN_DIR } from "./run-dir.ts";

/** The relay a release build dials; the page's sockets on it are carried to the test relay. */
export const PAIR_RELAY = "wss://relay-doriface.omo.dev";

const HOST_CLI = join(appDir, "..", "host", "src", "cli.ts");
const RIG = join(appDir, "e2e", "pair-rig.ts");
const BROWSER_APP = join(appDir, "e2e", "browser-window.cjs");
const WEB_DIST = process.env["DORIFACE_WEB_DIST"] ?? join(appDir, "..", "web", "dist");

export interface PairRig {
  /** The test relay's client bridge: the page's relay sockets are routed here. */
  readonly bridge: string;
  /** The stand-in relay's code lookup, answering what the host registered (#22). */
  readonly lookup: string;
  /** The web app the fresh browser loads, on its own loopback port. */
  readonly webUrl: string;
  /** What the app's environment needs to run its host against the test relay and load that web build. */
  readonly env: Record<string, string>;
  stop(): Promise<void>;
}

interface RigAnswer {
  readonly bridge: string;
  readonly lookup: string;
  readonly webUrl: string;
  readonly relay: string;
  readonly hostCli: string;
}

/** The stand-in relay and the web app's server, in their own Bun process (the runner is Node). */
export async function pairRig(): Promise<PairRig> {
  const wrapper = join(RUN_DIR, "pair-host-wrapper", "host.ts");
  const child = spawn("bun", [RIG, WEB_DIST, HOST_CLI, wrapper], {
    cwd: appDir,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const answer = await new Promise<RigAnswer>((resolve, reject) => {
    lines.once("line", (line) => {
      try {
        resolve(JSON.parse(line) as RigAnswer);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("exit", (code) => reject(new Error(`the pair rig exited (code ${String(code)})`)));
  });
  return {
    bridge: answer.bridge,
    lookup: answer.lookup,
    webUrl: answer.webUrl,
    env: {
      DORIFACE_HOST_BIN: wrapper,
      DORIFACE_E2E_HOST_CLI: answer.hostCli,
      DORIFACE_E2E_RELAY: answer.relay,
      DORIFACE_WEB_DIST: WEB_DIST,
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.stdin?.end();
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

/** Carries the page's sockets on the release relay's client path to the test relay's bridge, as a phone's would go. */
export async function routeRelay(page: Page, bridgeUrl: string): Promise<void> {
  // Any port: a session's second and third sockets dial the relay's other HTTPS ports (#1418).
  await page.routeWebSocket(/^wss:\/\/relay-doriface\.omo\.dev(:\d+)?\/v1\/client\//, (socket) => {
    const target = new URL(socket.url());
    const relay = new WebSocket(`${bridgeUrl}${target.pathname}${target.search}`);
    relay.binaryType = "arraybuffer";
    const early: (string | Uint8Array<ArrayBuffer>)[] = [];
    relay.addEventListener("open", () => {
      for (const frame of early.splice(0)) relay.send(frame);
    });
    socket.onMessage((message) => {
      const frame: string | Uint8Array<ArrayBuffer> = typeof message === "string" ? message : Uint8Array.from(message);
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

/** A fresh browser (its own Electron profile) with the pairing code lookup answered from the rig, on `url`. */
export async function freshBrowser(
  rig: PairRig,
  url: string,
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [BROWSER_APP, url], env });
  const page = await app.firstWindow();
  await routeRelay(page, rig.bridge);
  await page.route("https://relay-doriface.omo.dev/v1/pair/*", async (route) => {
    const slot = route
      .request()
      .url()
      .slice(route.request().url().lastIndexOf("/") + 1);
    const answer = await fetch(`${rig.lookup}/v1/pair/${slot}`);
    await route.fulfill({
      status: answer.status,
      body: await answer.text(),
      headers: { "content-type": "application/json" },
    });
  });
  return { app, page };
}
