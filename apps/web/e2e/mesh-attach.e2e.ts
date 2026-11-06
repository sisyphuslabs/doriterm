import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { routeRelaySockets } from "./relay-route.ts";
import { PRIVATE_RELAY_SKIP } from "./private-relay.ts";

// G009 C004: the web app paired with ONE mesh member lists another member's machine with its terminals and attaches to
// one of them, typing into it. Two real doriface-hosts with their own hc cores are joined by `mesh pair` and `mesh join`
// through the private relay under wrangler dev (no `hc machine add`), so this needs a relay checkout
// (DORIFACE_RELAY_DIR, as `bun run relay:fetch` makes) and is skipped without one. MESH_ATTACH_OUT keeps the captures.
test.skip(process.env["DORIFACE_RELAY_DIR"] === undefined, PRIVATE_RELAY_SKIP);
test.use({ serviceWorkers: "block" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const HELPER = join(import.meta.dirname, "..", "..", "..", "tests", "relay", "support", "web-mesh-hosts.ts");
let helper: ChildProcess | undefined;
let reader: AsyncIterator<string> | undefined;
let relayUrl = "";
let machine = "";

async function nextLine(prefix: string): Promise<string> {
  const next = await reader?.next();
  if (next === undefined || next.done === true) throw new Error(`mesh-hosts ended before a ${prefix.trim()} line`);
  return next.value.startsWith(prefix) ? next.value.slice(prefix.length) : nextLine(prefix);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  // Playwright sets FORCE_COLOR for its workers; wrangler would colour the line the helper waits for.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  helper = spawn("bun", [HELPER], { stdio: ["pipe", "pipe", "inherit"], env: { ...inherited, NO_COLOR: "1" } });
  if (helper.stdout === null) throw new Error("mesh-hosts has no stdout");
  reader = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  ({ relayUrl, machine } = JSON.parse(await nextLine("READY ")) as { relayUrl: string; machine: string });
});

test.afterAll(async () => {
  const running = helper;
  if (running === undefined) return;
  running.kill("SIGTERM");
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 90_000 }).not.toBeNull();
});

async function pairedWithA(browser: Browser, width: number, theme: "day" | "night"): Promise<Page> {
  const narrow = width < 600;
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width, height: narrow ? 844 : 900 },
    isMobile: narrow,
    hasTouch: narrow,
    colorScheme: theme === "day" ? "light" : "dark",
  });
  await context.addInitScript(
    (chosen) => localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] })),
    theme,
  );
  const page = await context.newPage();
  await routeRelaySockets(page, relayUrl);
  helper?.stdin?.write("PAIR\n");
  await page.goto(`/pair${await nextLine("LINK ")}`);
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByText("This device now reaches the host through the relay")).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click();
  return page;
}

async function keep(page: Page, name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path });
  const out = process.env["MESH_ATTACH_OUT"];
  if (out === undefined) return;
  mkdirSync(out, { recursive: true });
  copyFileSync(path, join(out, `${name}.png`));
}

for (const [size, width] of [
  ["1440", 1440],
  ["390", 390],
] as const) {
  for (const theme of ["day", "night"] as const) {
    test(`at ${size} in ${theme}, a terminal on another mesh member is listed under its machine and takes input`, async ({
      browser,
    }) => {
      const page = await pairedWithA(browser, width, theme);
      const row = page
        .getByRole("button", { name: /\bon-b\b/ })
        .filter({ hasText: machine })
        .first();
      if (width >= 600) {
        const group = page
          .getByRole("complementary", { name: "Workspace" })
          .getByRole("region", { name: machine, exact: true });
        await expect(group).toBeVisible({ timeout: 60_000 });
        await expect(group).toContainText("connected");
      }
      await expect(row).toBeVisible({ timeout: 60_000 });
      await keep(page, `machines-${size}-${theme}`);

      await row.click();
      const terminal = page.locator(`[data-terminal^="${machine}/"]:visible`).first();
      await expect(terminal).toContainText("$", { timeout: 30_000 });
      await terminal.click();
      await page.keyboard.type("echo mesh-$((6*7))-ok\r");
      await expect(terminal).toContainText("mesh-42-ok", { timeout: 30_000 });
      await keep(page, `attached-${size}-${theme}`);
      await page.context().close();
    });
  }
}
