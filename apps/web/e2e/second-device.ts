import type { Browser, Page } from "@playwright/test";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";

/**
 * A second device on the e2e core: its own browser context, so its own storage, its own connection and its own viewers.
 * The caller closes its context.
 */
export async function secondDevice(
  browser: Browser,
  viewport: { readonly width: number; readonly height: number },
): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport });
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
  return context.newPage();
}
