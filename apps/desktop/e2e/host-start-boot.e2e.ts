// The boot path (#265): the app starts with a saved This computer link while herdr-core is missing. It shows the
// typed cause with Retry and Open settings, and never opens a socket to the saved link in the host's place.
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOptions } from "./launch.ts";

/** What This computer saves: a loopback link. Its port and token are a previous launch's, so boot starts the host again. */
const SAVED = {
  mode: "loopback",
  relayUrl: "",
  directUrl: "",
  hostId: "",
  hostKey: "",
  loopbackUrl: "ws://127.0.0.1:9/v1/hc",
  token: "a-previous-launch-token",
};

test("booting with a saved This computer link and no herdr-core shows Retry and Open settings and opens no socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-host-start-boot-"));
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      HC_BIN: join(dir, "no-such-hc"),
      DORIFACE_HOST_STATE_DIR: join(dir, "host-state"),
      XDG_STATE_HOME: join(dir, "state"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const launch = async () => electron.launch(await launchOptions([`--user-data-dir=${join(dir, "profile")}`], { env }));
  try {
    // The first launch saves the link, as choosing This computer would have.
    const first = await launch();
    try {
      const page = await first.firstWindow();
      await page.waitForSelector("#root > *");
      await page.evaluate((link) => localStorage.setItem("doriface.connection", JSON.stringify(link)), SAVED);
    } finally {
      await first.close();
    }

    const app = await launch();
    try {
      const page = await app.firstWindow();
      await page.waitForSelector("#root > *");
      // Counts every socket the page opens, from its very first script on the reload below. On the page, not the
      // context: unpackaged, a context init script never reaches the reloaded app:// page.
      await page.addInitScript(() => {
        const opened: string[] = [];
        Object.assign(window, { openedSockets: opened });
        const Native = window.WebSocket;
        window.WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            opened.push(String(url));
          }
        };
      });
      const sockets: string[] = [];
      page.on("websocket", (socket) => sockets.push(socket.url()));
      await page.reload();

      const notice = page.getByRole("alert").filter({ hasText: "This computer's host did not start" });
      await expect(notice).toBeVisible({ timeout: 20_000 });
      await expect(notice.locator("[data-host-start-code]")).toHaveAttribute(
        "data-host-start-code",
        "hc-binary-missing",
      );
      await expect(notice.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(notice.getByRole("link", { name: "Open settings" })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("host-start-boot.png") });
      // The boot has settled on the notice: nothing connected to the saved link behind it.
      // The counter is installed (an array), and it counted nothing.
      expect(await page.evaluate(() => Reflect.get(window, "openedSockets") as unknown)).toEqual([]);
      expect(sockets).toEqual([]);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
