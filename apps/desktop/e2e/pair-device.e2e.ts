// #614: this computer offers itself, and a fresh browser pairs with the code from the window. The desktop app runs a
// real doriface-host, whose relay uplink is carried to a stand-in relay, so no spec touches a deployed relay.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, pressNewTab } from "./launch.ts";
import { freshBrowser, pairRig, type PairRig } from "./pair-harness.ts";

test.setTimeout(300_000);

let rig: PairRig;
let hc: ReturnType<typeof scratchHcSession>;
let profile: string;
let shellHome: string | undefined;
let env: Record<string, string>;
let app: ElectronApplication | undefined;
let fresh: ElectronApplication | undefined;
let page: Page;

const originOf = (target: Page): string => {
  const url = new URL(target.url());
  return `${url.protocol}//${url.host}`;
};

// oxlint-disable-next-line no-empty-pattern -- Playwright reads a hook's fixtures from this pattern; this one takes the hook's own timeout.
test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  rig = await pairRig();
  hc = scratchHcSession();
  profile = mkdtempSync(join(tmpdir(), "dd-pair-"));
  // A shell that starts clean, as the other launch specs pin it: bash without profile or rc files and a scratch HOME,
  // so the prompt the paired terminal waits for is "$ " on every runner, not whatever the machine's own shell draws.
  shellHome = mkdtempSync(join(tmpdir(), "dd-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/bash --noprofile --norc -i\n", { mode: 0o755 });
  env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      ...rig.env,
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
      PS1: "$ ",
      ENV: "",
      BASH_SILENCE_DEPRECATION_WARNING: "1",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  app = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
  page = await app.firstWindow();
  const started = page.getByRole("button", { name: "Use this computer" });
  const workspace = page
    .getByRole("button", { name: "New tab" })
    .or(page.getByRole("button", { name: "New terminal" }))
    .first();
  // The first paint may land after `firstWindow()`; wait for it before deciding which screen this is.
  await expect(started.or(workspace)).toBeVisible({ timeout: 120_000 });
  if (await started.isVisible()) await started.click();
  await expect(workspace).toBeVisible({ timeout: 120_000 });
});

test.afterAll(async () => {
  await fresh?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  await hc?.dispose().catch(() => undefined);
  await rig?.stop().catch(() => undefined);
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  if (shellHome !== undefined) rmSync(shellHome, { recursive: true, force: true });
});

test("Settings offers this computer, and a fresh browser pairs with the code it shows", async () => {
  if (app === undefined) throw new Error("the app did not launch");
  await page.goto(`${originOf(page)}/settings`);
  await page
    .getByRole("navigation", { name: "Settings", exact: true })
    .getByRole("button", { name: "This device", exact: true })
    .or(page.getByRole("tab", { name: "This device", exact: true }))
    .filter({ visible: true })
    .click();

  await page.getByRole("button", { name: "Pair a device", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a device" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: "QR code for this computer's pairing link" })).toBeVisible();
  const code = (await dialog.locator("[data-pair-code]").innerText()).replace(/\s/g, "");
  expect(code).toMatch(/^[0-9A-Z]{8}$/);
  await expect(dialog.getByRole("textbox", { name: "Pairing link" })).toHaveValue(
    /^doriface:\/\/pair#h=.+&k=.+&s=.+&p=.+&r=/,
  );
  await expect(dialog.getByText("This computer's key (SHA-256)")).toBeVisible();
  const fingerprint = await dialog.locator("figure p").innerText();
  expect(fingerprint.replace(/\s/g, "")).toMatch(/^[0-9A-F]{40}$/);
  await expect(dialog.getByText(/^Expires in \d+:\d\d\.$/)).toBeVisible();

  const browser = await freshBrowser(rig, `${rig.webUrl}/pair`, env);
  fresh = browser.app;
  // A fresh browser lands on the mesh join entry (#1446, #1552). A typed code is offered as a mesh join first; Join
  // finds the code is this computer's device offer and hands over to the host key check below.
  await expect(browser.page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await browser.page.getByLabel("Invite link or code").fill(`${code.slice(0, 4)} ${code.slice(4)}`);
  await browser.page.getByRole("button", { name: "Continue", exact: true }).click();
  await browser.page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(browser.page.getByRole("heading", { name: "Check the host's key" })).toBeVisible({ timeout: 60_000 });
  await browser.page.getByRole("button", { name: "They match", exact: true }).click();
  await expect(browser.page.getByText("Paired", { exact: true })).toBeVisible({ timeout: 60_000 });

  await expect(dialog.getByText(/^Paired with .+/)).toBeVisible({ timeout: 60_000 });

  await browser.page.getByRole("link", { name: "Open terminals" }).click();
  await pressNewTab(browser.page, { timeout: 60_000 });
  const terminal = browser.page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 60_000 });
  // The pane takes the keys through its own focus; a click that misses during a reflow is not a failure.
  await terminal.click({ timeout: 15_000 }).catch(() => undefined);
  await browser.page.keyboard.type("echo paired-ok");
  await browser.page.keyboard.press("Enter");
  await expect(terminal).toContainText("paired-ok", { timeout: 60_000 });
});
