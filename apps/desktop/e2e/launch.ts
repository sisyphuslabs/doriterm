import type { Page } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** CI points this at the electron-builder --dir output so the packaged app is what launches. */
export const packagedExecutable = process.env["DORIFACE_E2E_EXECUTABLE"];

const hideWindows = join(appDir, "e2e", "hide-windows.cjs");

/**
 * Linux e2e runs draw on xvfb, which has no GPU. Without --disable-gpu the GPU process first brings up Mesa's GL
 * (ANGLE over GLX, loading libLLVM and libgallium) only to end up compositing in software anyway. No frame can be
 * composited until that is done, so neither ready-to-show nor a page.screenshot capture can happen; on a cold CI runner
 * that took from seconds to over 30 s (#80).
 */
export const platformArgs: readonly string[] = process.platform === "linux" ? ["--disable-gpu"] : [];

/**
 * The command-line arguments every e2e launch passes, followed by `extra`: from this checkout they start the app with
 * every window hidden (Electron's -r loads the hook before the app); a packaged executable cannot load the hook.
 */
export function appArgs(extra: readonly string[] = [], { gpu = false } = {}): string[] {
  const args = [...(gpu ? [] : platformArgs), ...extra];
  return packagedExecutable === undefined ? ["-r", hideWindows, appDir, ...args] : args;
}

const attachAfterFirstLoad = join(appDir, "e2e", "attach-after-first-load.ts");

/**
 * What every electron.launch() takes besides `env`. The packaged app always starts through attach-after-first-load:
 * attached directly, Playwright can land while the first navigation is in flight and then waits forever (#13).
 */
export function launchOptions(
  extra: readonly string[] = [],
  { gpu = false } = {},
): { readonly args: string[] } | { readonly executablePath: string; readonly args: string[] } {
  const args = appArgs(extra, { gpu });
  return packagedExecutable === undefined ? { args } : { executablePath: attachAfterFirstLoad, args };
}

/** Opens a terminal through the strip's New tab menu, or the empty workspace's direct New terminal button. */
export async function pressNewTab(page: Page, options: { readonly timeout?: number } = {}): Promise<void> {
  const button = page
    .getByRole("button", { name: "New tab" })
    .or(page.getByRole("button", { name: "New terminal" }))
    .first();
  await button.click(options);
  if ((await button.getAttribute("aria-haspopup")) === "menu") {
    await page.getByRole("menuitem", { name: /^Terminal/ }).click(options);
  }
}
