// The workspace with an added machine, connected, unreachable and asking for a login, in both themes at 1440 and
// 390: CAPTURE=1 bunx playwright test machines-capture
import { type Browser, devices, type Page } from "@playwright/test";
import { join } from "node:path";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow, newOn, switchOn, switchTo, OFFLINE_BOUND_MS, OFFLINE_TEST_TIMEOUT_MS } from "./machine-switch.ts";
import { expect, test } from "./fixtures.ts";
import { clearLayouts } from "./layout-doc.ts";

const OUT = join(import.meta.dirname, "../../../docs/design/app");
const SHOTS = [
  { width: "1440", theme: "day" },
  { width: "1440", theme: "night" },
  { width: "390", theme: "day" },
  { width: "390", theme: "night" },
] as const;
type Shot = (typeof SHOTS)[number];

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");
test.use({ page: async ({ page }, use) => use(page) });

async function openPage(browser: Browser, { width, theme }: Shot): Promise<{ page: Page; close: () => Promise<void> }> {
  const size = width === "1440" ? { viewport: { width: 1440, height: 900 } } : devices["iPhone 14"];
  const { defaultBrowserType: _browser, ...use } = { defaultBrowserType: "chromium", ...size };
  clearLayouts();
  const context = await browser.newContext({ ...use, colorScheme: theme === "day" ? "light" : "dark" });
  const connection = {
    mode: "loopback",
    relayUrl: "",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript(
    ([chosen, stored]) => {
      localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
      localStorage.setItem("doriface.connection", stored);
    },
    [theme, JSON.stringify(connection)] as const,
  );
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible({ timeout: 20_000 });
  return { page, close: () => context.close() };
}

async function shoot(page: Page, shot: Shot, name: string): Promise<void> {
  if (shot.width === "390") {
    await page
      .getByRole("heading", { name: "Spaces" })
      .evaluate((heading) => heading.scrollIntoView({ block: "center" }));
  }
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(OUT, `${name}-${shot.width}-${shot.theme}.png`) });
}

/** The 1440 shot shows a shell started on the machine, attached at its machine/tN address. */
async function remoteShell(page: Page): Promise<void> {
  await newOn(page).click({ force: true });
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await expect(focused).toHaveAttribute("data-terminal", new RegExp(`^${MACHINE_NAME}/t\\d+$`), { timeout: 15_000 });
  await expect(focused).toContainText("$", { timeout: 15_000 });
  await focused.click();
  // A login shell's prompt names the machine and user running the capture; a neutral one keeps them out of it.
  await page.keyboard.type("PS1='$ '; clear\r");
  await expect(focused).toHaveText(/^\$\s+Press Escape/, { timeout: 15_000 });
  await page.keyboard.type("echo on-build-box-$((40 + 2))\r");
  await expect(focused).toContainText("on-build-box-42", { timeout: 15_000 });
}

/** One shot after another: they share the machine, so they cannot run side by side. */
async function eachShot(take: (shot: Shot) => Promise<void>, index = 0): Promise<void> {
  const shot = SHOTS[index];
  if (shot === undefined) return;
  await take(shot);
  return eachShot(take, index + 1);
}

test("machines, connected", async ({ browser }) => {
  await eachShot(async (shot) => {
    const { page, close } = await openPage(browser, shot);
    await expect(machineRow(page)).toContainText("connected", { timeout: 30_000 });
    if (shot.width === "1440") await remoteShell(page);
    await shoot(page, shot, "machines");
    if (shot.width === "1440") {
      await page.keyboard.type("exit\r");
      await expect(machineRow(page)).toContainText(/connected\s*2/, { timeout: 15_000 });
    }
    await close();
  });
});

for (const [mode, name, state] of [
  ["off", "machines-unreachable", "offline"],
  ["login", "machines-needs-login", "needs login"],
] as const) {
  test(`machines, ${state}`, async ({ browser }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    try {
      switchTo(mode);
      await eachShot(async (shot) => {
        const { page, close } = await openPage(browser, shot);
        await expect(machineRow(page)).toContainText(state, { timeout: OFFLINE_BOUND_MS });
        await shoot(page, shot, name);
        await close();
      });
    } finally {
      switchOn();
    }
  });
}
