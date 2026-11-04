// The layout spec's screens: each opens one state of the app with the layout host's long names on the page.
import type { Page } from "@playwright/test";
import { BAD_LINK, fakeRelay, PAIR_CODE, PAIR_LINK, PAIRING_SETTINGS } from "./capture-relay.ts";
import { E2E_LAYOUT_PORT, E2E_TOKEN } from "./config.ts";
import { expect } from "./fixtures.ts";
import { LAYOUT_TERMINALS, UNBROKEN } from "./layout-seed.ts";

export const STARTS = {
  layout: {
    mode: "loopback",
    relayUrl: "",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_LAYOUT_PORT}/v1/hc`,
    token: E2E_TOKEN,
  },
  unreachable: {
    mode: "loopback",
    relayUrl: "",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:9/v1/hc/${UNBROKEN}`,
    token: E2E_TOKEN,
  },
  pairing: PAIRING_SETTINGS,
  none: null,
} as const;

export interface Screen {
  readonly name: string;
  readonly start: keyof typeof STARTS;
  /** Only on the desktop shell (wide) or the phone shell (narrow). */
  readonly only?: "wide" | "narrow";
  readonly storageFails?: true;
  readonly open: (page: Page, narrow: boolean) => Promise<unknown>;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const row = (page: Page, title: string) => page.getByRole("button", { name: new RegExp(escape(title)) }).first();

async function workspace(page: Page, narrow: boolean): Promise<void> {
  await page.goto("/");
  if (narrow) await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  else await expect(page.getByRole("contentinfo").getByText(/^\d+ terminals?\b/)).toBeVisible({ timeout: 20_000 });
  await expect(row(page, "remote-terraform-plan-runner-001")).toBeVisible({ timeout: 20_000 });
}

async function section(page: Page, narrow: boolean, label: string): Promise<void> {
  await page.goto("/settings");
  if (narrow) await page.getByRole("tab", { name: label }).click();
  else await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: label }).click();
}

async function choose(page: Page, button: string, text: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: button }).click();
  await (await chooser).setFiles({ name: "config", mimeType: "text/plain", buffer: Buffer.from(text) });
  await expect(page.getByRole("dialog")).toBeVisible();
}

const LONG_VALUE = `${UNBROKEN}${UNBROKEN}`;

export const SCREENS: readonly Screen[] = [
  { name: "first-run", start: "none", open: (page) => page.goto("/") },
  { name: "pair", start: "pairing", open: (page) => page.goto("/pair") },
  {
    name: "pair-code-error",
    start: "pairing",
    open: async (page) => {
      await page.goto("/pair");
      await page.getByLabel("Pairing code").fill(LONG_VALUE);
      await page.getByRole("button", { name: "Pair" }).click();
      await expect(page.getByText("Enter the 8 characters")).toBeVisible();
    },
  },
  { name: "pair-verify", start: "pairing", open: (page) => page.goto(PAIR_LINK) },
  { name: "pair-link-invalid", start: "pairing", open: (page) => page.goto(BAD_LINK) },
  {
    name: "pair-refused",
    start: "pairing",
    open: async (page) => {
      await fakeRelay(page, 4429);
      await page.goto("/pair");
      await page.getByLabel("Pairing code").fill(PAIR_CODE);
      await page.getByRole("button", { name: "Pair" }).click();
      await page.getByRole("button", { name: "They match" }).click();
      await expect(page.getByText("Pairing did not finish")).toBeVisible({ timeout: 15_000 });
    },
  },
  {
    name: "unreachable",
    start: "unreachable",
    open: async (page) => {
      await page.goto("/");
      await expect(page.getByText("Cannot reach your host")).toBeVisible({ timeout: 20_000 });
    },
  },
  {
    name: "unreachable-settings",
    start: "unreachable",
    open: (page, narrow) => section(page, narrow, "Connections"),
  },
  { name: "workspace", start: "layout", open: workspace },
  {
    name: "tabs-split",
    start: "layout",
    only: "wide",
    open: async (page) => {
      await workspace(page, false);
      // Each click opens the next tab, in order.
      await LAYOUT_TERMINALS.reduce(
        (opened, { title }) => opened.then(() => row(page, title).click()),
        Promise.resolve(),
      );
      await row(page, "remote-terraform-plan-runner-001").click();
      await page.getByRole("button", { name: "Split right" }).click();
      await expect(page.locator("[data-terminal]:visible")).toHaveCount(2);
    },
  },
  {
    name: "terminal",
    start: "layout",
    open: async (page, narrow) => {
      await workspace(page, narrow);
      await row(page, LAYOUT_TERMINALS[1]?.title ?? "").click();
      await expect(page.locator("[data-terminal]:visible").first()).toContainText("$", { timeout: 15_000 });
    },
  },
  {
    name: "machine-terminal",
    start: "layout",
    open: async (page, narrow) => {
      await workspace(page, narrow);
      await row(page, "remote-terraform-plan-runner-001").click();
      await expect(page.locator("[data-terminal]:visible").first()).toContainText("$", { timeout: 15_000 });
    },
  },
  {
    name: "palette",
    start: "layout",
    open: async (page, narrow) => {
      await workspace(page, narrow);
      await page.getByRole("button", { name: "Command palette" }).first().click();
      await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
    },
  },
  ...(["Connections", "Appearance", "Device", "Terminal", "Keybindings"] as const).map((label): Screen => ({
    name: `settings-${label.toLowerCase()}`,
    start: "layout",
    open: (page, narrow) => section(page, narrow, label),
  })),
  {
    name: "settings-storage-error",
    start: "layout",
    storageFails: true,
    open: async (page, narrow) => {
      await section(page, narrow, "Keybindings");
      await expect(page.getByRole("alert").first()).toBeVisible();
    },
  },
  {
    name: "dialog-import-config",
    start: "layout",
    open: async (page, narrow) => {
      await section(page, narrow, "Terminal");
      await choose(
        page,
        "Import Ghostty config…",
        `font-family = ${LONG_VALUE}\n${UNBROKEN} = 1\ncursor-style = ${UNBROKEN}\n`,
      );
    },
  },
  {
    name: "dialog-import-keybinds",
    start: "layout",
    open: async (page, narrow) => {
      await section(page, narrow, "Keybindings");
      await choose(page, "Import keybinds…", `keybind = ctrl+shift+t=new_tab\nkeybind = ${LONG_VALUE}\n`);
    },
  },
];
