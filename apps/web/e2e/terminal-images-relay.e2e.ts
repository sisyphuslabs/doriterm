import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { E2E_WEB_PORT } from "./config.ts";
import { expect, pressNewTab, test } from "./fixtures.ts";
import { routeRelaySockets } from "./relay-route.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";
import { expectImageBelow, graphics, lines, png, RED, show, SIZE, BLUE } from "./terminal-images.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const ROOT = join(import.meta.dirname, "..", "..", "..");
const RELAY_DIR = process.env["DORIFACE_RELAY_DIR"] ?? join(ROOT, ".relay");
// The relay is private; `bun run relay:fetch` checks it out, as the Relay e2e job does.
test.skip(!existsSync(join(RELAY_DIR, "package.json")), PRIVATE_RELAY_SKIP);

let driver: ChildProcess | undefined;
let link = "";
let relayUrl = "";

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // A clean environment: wrangler dev never comes up under the test runner's own variables.
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "TMPDIR", "HC_BIN", "DORIFACE_RELAY_DIR"].flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const script = join(ROOT, "tests/relay/support/browser-relayed-host.ts");
  driver = spawn("bun", [script, `http://127.0.0.1:${E2E_WEB_PORT}`], {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const out = driver.stdout;
  if (out === null) throw new Error("the relayed host has no stdout");
  for await (const line of createInterface({ input: out })) {
    if (!line.startsWith("{")) continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && "link" in parsed && typeof parsed.link === "string") {
      link = parsed.link;
      if ("relayUrl" in parsed && typeof parsed.relayUrl === "string") relayUrl = parsed.relayUrl;
      break;
    }
  }
  if (link === "") throw new Error("the relayed host printed no pairing link");
});

test.afterAll(async () => {
  const running = driver;
  if (running === undefined || running.exitCode !== null) return;
  running.kill("SIGTERM");
  // It stops the relay, the host and the core before it exits.
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 60_000 }).not.toBeNull();
});

test("over a relay, a Kitty PNG and raw RGBA are drawn at their cells, and stay there through scrolling and a resize", async ({
  page,
}) => {
  // Pairing dials the link's relay; the workspace then dials the production one, as every release build does (#452).
  await routeRelaySockets(page, relayUrl);
  await page.goto(link);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("doriface.connection") ?? "{}").mode))
    .toBe("relay");
  await page.getByRole("link", { name: "Open terminals" }).click();
  // The relayed host's own core, not the e2e worker's: open a terminal on it and wait for its prompt.
  // "+" opens the new-item menu since #548; pressNewTab picks its Terminal item.
  await pressNewTab(
    page
      .getByRole("button", { name: "New terminal" })
      .or(page.getByRole("button", { name: "New tab" }))
      .first(),
    { timeout: 30_000 },
  );
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 30_000 });

  await show(page, terminal, "relay-png", graphics("a=T,f=100", png(RED).toString("base64")));
  await expectImageBelow(terminal, "relay-png", RED);
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let at = 0; at < rgba.length; at += 4) rgba.set([0, 0, 255, 255], at);
  await show(page, terminal, "relay-rgba", graphics(`a=T,f=32,s=${SIZE},v=${SIZE}`, rgba.toString("base64")));
  await expectImageBelow(terminal, "relay-rgba", BLUE);

  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("seq 1 4");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await lines(terminal)).includes("4"), { timeout: 15_000 }).toBe(true);
  await expectImageBelow(terminal, "relay-png", RED);
  await expectImageBelow(terminal, "relay-rgba", BLUE);

  await page.setViewportSize({ width: 900, height: 700 });
  await expectImageBelow(terminal, "relay-png", RED);
  await expectImageBelow(terminal, "relay-rgba", BLUE);
});
