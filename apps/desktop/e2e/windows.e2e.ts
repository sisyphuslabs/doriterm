import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import electronBinary from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { appArgs, launchOptions, packagedExecutable } from "./launch.ts";

const CLOSE_TAB = process.platform === "darwin" ? "Meta+KeyW" : "Control+Shift+KeyW";

/** The clicks that ask a browser for a new window or tab on this platform; Control-click is a right-click on macOS. */
const NEW_WINDOW_CLICKS = [
  { modifiers: [process.platform === "darwin" ? "Meta" : "Control"] },
  { modifiers: ["Shift"] },
  { button: "middle" },
] as const;
type NewWindowClick = (typeof NEW_WINDOW_CLICKS)[number];

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly env: Record<string, string>;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

const profileArg = (profile: string): string => `--user-data-dir=${profile}`;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-windows-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...hc.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  scratch = { hc, profile, env };
  launched = await electron.launch(await launchOptions([profileArg(profile)], { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
    }
  }
});

const running = (): ElectronApplication => {
  if (launched === undefined) throw new Error("the app did not launch");
  return launched;
};

const windowCount = (): Promise<number> =>
  running().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** `URL.origin` is "null" for the app: scheme, so the origin is rebuilt from its parts. */
const originOf = (page: Page): string => {
  const url = new URL(page.url());
  return `${url.protocol}//${url.host}`;
};

async function appPage(): Promise<Page> {
  const page =
    running()
      .windows()
      .find((candidate) => !candidate.isClosed()) ?? (await running().firstWindow());
  await page.waitForSelector("#root > *");
  return page;
}

test("the app is named Doriterm", async () => {
  const name = await running().evaluate(({ app }) => app.getName());
  expect(name).toBe("Doriterm");
});

test("storage keeps the folder installs already use, unless a profile is named", async () => {
  const storage = await running().evaluate(({ app }) => ({
    path: app.getPath("userData"),
    named: app.commandLine.hasSwitch("user-data-dir"),
  }));
  if (scratch === undefined) throw new Error("no scratch profile");
  expect(storage.named).toBe(true);
  expect(storage.path).toBe(scratch.profile);
});

test("a second launch and a Dock click bring back the one window", async () => {
  await appPage();
  if (scratch === undefined) throw new Error("no scratch profile");
  const second = spawn(packagedExecutable ?? String(electronBinary), appArgs([profileArg(scratch.profile)]), {
    env: scratch.env,
    stdio: "ignore",
  });
  const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
  expect(code).toBe(0);
  expect(await windowCount()).toBe(1);
  await running().evaluate(({ app }) => app.emit("activate"));
  expect(await windowCount()).toBe(1);
});

/** A new-window click on the first link of `/`: the one window shows its page without reloading. */
async function newWindowClick(page: Page, click: NewWindowClick): Promise<void> {
  const name = JSON.stringify(click);
  const origin = originOf(page);
  await page.goto(`${origin}/`);
  await page.waitForSelector("#root > *");
  await page.evaluate(() => Reflect.set(window, "sameDocument", true));
  const link = page.locator("a[href]").first();
  const href = (await link.getAttribute("href")) ?? "";
  await link.click({ ...click, modifiers: "modifiers" in click ? [...click.modifiers] : [] });
  await expect(page).toHaveURL(`${origin}${href}`);
  expect(await page.evaluate(() => Reflect.get(window, "sameDocument")), `${name} reloaded`).toBe(true);
  expect(await windowCount(), name).toBe(1);
}

test("new-window clicks and window.open navigate the one window in place", async () => {
  const page = await appPage();
  const origin = originOf(page);
  for (const click of NEW_WINDOW_CLICKS) {
    // oxlint-disable-next-line no-await-in-loop -- one window: each click is checked before the next page load
    await newWindowClick(page, click);
  }
  await page.evaluate(() => window.open("/settings", "_blank"));
  await expect(page).toHaveURL(`${origin}/settings`);
  expect(await page.evaluate(() => Reflect.get(window, "sameDocument"))).toBe(true);
  await page.evaluate(() => window.open("https://example.com/", "_blank"));
  expect(await windowCount()).toBe(1);
});

test("Escape and the close control leave Settings in the desktop window", async () => {
  const page = await appPage();
  const origin = originOf(page);
  const closeControl = page.getByRole("button", { name: "Close settings" }).first();
  await page.goto(`${origin}/`);
  await page.goto(`${origin}/settings`);
  // goto returns at the load event, which can come before React has drawn anything; Escape goes to Settings once it is
  // on screen, as a person's does (#1367).
  await expect(closeControl).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${origin}/`);
  await page.goto(`${origin}/settings`);
  await closeControl.click();
  await expect(page).toHaveURL(`${origin}/`);
  expect(await windowCount()).toBe(1);
});

test("the close-tab shortcut with nothing to close asks the window to close", async () => {
  const page = await appPage();
  await page.goto(`${originOf(page)}/`);
  await page.waitForSelector("#root > *");
  await running().evaluate(({ BrowserWindow }) => {
    Reflect.set(globalThis, "closeAsked", false);
    BrowserWindow.getAllWindows()[0]?.once("close", (event) => {
      event.preventDefault();
      Reflect.set(globalThis, "closeAsked", true);
    });
  });
  // Only the keydown: the keymap acts on it, and the page asking to close takes the keyup's target away.
  for (const key of CLOSE_TAB.split("+")) {
    // oxlint-disable-next-line no-await-in-loop -- modifiers go down before the key, in order
    await page.keyboard.down(key);
  }
  await expect.poll(() => running().evaluate(() => Reflect.get(globalThis, "closeAsked"))).toBe(true);
});

test("the window paints the in-app theme's background, not only the system's", async () => {
  const page = await appPage();
  await page.evaluate(() =>
    localStorage.setItem("doriface.appearance", JSON.stringify({ theme: "graphite", custom: [] })),
  );
  await page.reload();
  await page.waitForSelector("#root > *");
  const expected = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--background").trim().toLowerCase(),
  );
  expect(expected).toBe("#131518");
  await expect
    .poll(() =>
      running().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase()),
    )
    .toBe(expected);
});

test("Settings… in the macOS app menu opens Settings, also after the window was closed", async () => {
  test.skip(process.platform !== "darwin", "the app menu with Settings… exists only on macOS");
  const clickSettings = () =>
    running().evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.items[0]?.submenu?.items.find((entry) => entry.label === "Settings…");
      item?.click();
      return item !== undefined;
    });
  const page = await appPage();
  await page.goto(`${originOf(page)}/`);
  expect(await clickSettings()).toBe(true);
  await expect(page).toHaveURL(/\/settings$/);

  await running().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
  expect(await windowCount()).toBe(0);
  const reopened = running().waitForEvent("window");
  await clickSettings();
  const next = await reopened;
  await expect(next).toHaveURL(/\/settings$/);
  expect(await windowCount()).toBe(1);
});
