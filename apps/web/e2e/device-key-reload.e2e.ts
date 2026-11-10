import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startFakeRelayHost } from "./relay-route.ts";
import { RUN_DIR } from "./run-dir.ts";

// #1329: WebKit's IndexedDB hands a stored X25519 CryptoKey back as null, so a browser that kept its device key only as
// a CryptoKey loaded as a new device after a reload, and the host refused it as unknown. This is that reload in a real
// engine: the key the page presents after it is the one the host paired, and the host still holds that one device.
const ENTRY = join(import.meta.dirname, "device-key-page.ts");
const BUNDLE = join(RUN_DIR, "device-key-page.js");
/** The path this spec serves the entry on: the app's build writes no such file, and this page is the only one that asks. */
const HARNESS_URL = "/__device-key-page.js";

/** The entry as the page runs it: built for the browser by bun, on the page's own device key and IndexedDB. */
function bundle(): string {
  execFileSync(
    "bun",
    ["build", ENTRY, "--target=browser", "--format=esm", "--outfile", BUNDLE, "--define", "import.meta.env.DEV=false"],
    { stdio: "pipe" },
  );
  return readFileSync(BUNDLE, "utf8");
}

/** The device public key the page holds now, read by the page's own `loadDeviceKey`. */
async function deviceKeyPublic(page: Page): Promise<string> {
  const key: unknown = await page.evaluate(async (specifier) => {
    const loaded: unknown = await import(specifier);
    const fn: unknown =
      typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "deviceKeyPublic") : undefined;
    if (typeof fn !== "function") throw new Error("the device-key entry exports no deviceKeyPublic");
    return await Reflect.apply(fn, loaded, []);
  }, HARNESS_URL);
  if (typeof key !== "string") throw new Error("the page answered no device public key");
  return key;
}

test("a paired device is still known after the page reloads (#1329)", async ({ browser, baseURL }) => {
  const host = await startFakeRelayHost({ terminal: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(baseURL === undefined ? {} : { baseURL }),
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    await host.route(page);
    const entry = bundle();
    await page.route(`**${HARNESS_URL}`, (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: entry }),
    );

    await page.goto(await host.pairingLink());
    await page.getByRole("button", { name: "They match" }).click();
    await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("link", { name: "Open terminals" })
      .or(page.getByRole("button", { name: "Open terminals" }))
      .click();
    await expect(page.locator("[data-terminal]").first()).toBeVisible({ timeout: 60_000 });

    // The host recorded this browser's device key when it paired, and the page presents exactly that key.
    const paired = await host.devices();
    expect(paired).toHaveLength(1);
    const known = paired[0]?.clientStaticPub;
    if (known === undefined) throw new Error("the host paired no device");
    expect(await deviceKeyPublic(page)).toBe(known);

    await page.reload();
    // The reloaded page still presents the key the host paired: another key would be an unknown device to it.
    expect(await deviceKeyPublic(page)).toBe(known);
    // And the host still holds that one device: the reload added no second one.
    expect(await host.devices()).toEqual(paired);
    // The host accepted a session from that key: the core's existing terminal is listed again over the new handshake.
    await expect(page.locator("[data-terminal]").first()).toBeVisible({ timeout: 60_000 });
  } finally {
    await context.close();
    await host.stop();
  }
});
