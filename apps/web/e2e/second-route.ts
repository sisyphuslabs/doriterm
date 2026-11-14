// A second route to the e2e machines (#2531, #2537): the e2e host's added machine gets a doriface-host gateway of its
// own, and adds the e2e host's core back, so a page that goes through it lists the same two machines as a page that
// goes through the e2e host. A route change is a reload with the other gateway's address saved.
import type { Page } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { E2E_HOST_ENV, E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect } from "./fixtures.ts";
import { MACHINE_ENV } from "./machine.ts";
import { hcOn } from "./machine-switch.ts";
import { readSavedEnv } from "./saved-env.ts";

/** The e2e host's core: its hello names it so, and the second core adds it under that name. */
export const FIRST = "studio";
/** The second core names itself `build`; the e2e host lists it as MACHINE_NAME. One machine either way. */
export const SECOND_OWN = "build";
export const FIRST_URL = `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

export interface SecondRoute {
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/** Starts the second gateway and adds the first core to the second; `stop` undoes both. */
export async function startSecondRoute(): Promise<SecondRoute> {
  const first = readSavedEnv(E2E_HOST_ENV);
  const second = readSavedEnv(MACHINE_ENV);
  const session = second.env["HC_SESSION"];
  if (session === undefined) throw new Error(`${MACHINE_ENV} names no HC_SESSION`);
  const env = Object.entries(first.env)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  // A worker that restarts after a failed test runs this again: the machine an earlier run added goes first.
  if (hcOn("machine", ["machine", "ls"]).includes(FIRST)) hcOn("machine", ["machine", "rm", FIRST]);
  hcOn("machine", ["machine", "add", "--via", `sh -c 'exec env ${env} sh -c "$1"' sh`, "--name", FIRST]);
  const port = await freePort();
  const gateway: ChildProcess = spawn(
    "bun",
    [
      join(import.meta.dirname, "../../host/src/cli.ts"),
      "--listen",
      `127.0.0.1:${port}`,
      "--hc",
      second.hc,
      "--session",
      session,
      "--token",
      E2E_TOKEN,
      "--no-relay",
    ],
    { env: { ...process.env, ...second.env }, stdio: "inherit" },
  );
  const stop = async (): Promise<void> => {
    if (gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill("SIGTERM");
      await expect.poll(() => gateway.exitCode ?? gateway.signalCode, { timeout: 30_000 }).not.toBeNull();
    }
    hcOn("machine", ["machine", "rm", FIRST]);
  };
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${port}/healthz`).then(
          (answer) => answer.status,
          () => 0,
        ),
      { timeout: 30_000 },
    )
    .toBe(200);
  return { url: `ws://127.0.0.1:${port}/v1/hc`, stop };
}

/** Opens the workspace with the page's saved connection on the gateway at `url`: a cold start through that host. */
export async function routeThrough(page: Page, url: string): Promise<Page> {
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    token: E2E_TOKEN,
  };
  await page.addInitScript(
    (value) => localStorage.setItem("doriface.connection", value),
    JSON.stringify({ ...settings, loopbackUrl: url }),
  );
  await page.goto("/");
  await expect(page.locator("[data-machine-row]")).toHaveCount(2, { timeout: 30_000 });
  return page;
}
