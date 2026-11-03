import type { Page } from "@playwright/test";
import { BAD_LINK, fakeRelay, PAIR_CODE, PAIR_LINK } from "./capture-relay.ts";
import { expect } from "./fixtures.ts";
import { machineRow, STATE_BOUND_MS } from "./machine-switch.ts";

export type Width = "1440" | "390";
/** Which stored connection a shot starts from: the e2e host, pairing against the fake relay, or none. */
export type Start = "connected" | "pairing" | "none";

export interface Shot {
  readonly name: string;
  readonly start: Start;
  /** Only at this width: the phone views exist below `md` only. */
  readonly only?: Width;
  readonly storageFails?: true;
  readonly run: (page: Page, width: Width) => Promise<void>;
}

const focusedTerminal = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');
/** Opens the seeded terminal whose sidebar row matches, so the shot never depends on which tab opened first. */
const openTerminal = async (page: Page, name: RegExp, text: string | RegExp) => {
  await page.getByRole("button", { name }).first().click();
  await expect(focusedTerminal(page)).toContainText(text, { timeout: 15_000 });
};
const section = async (page: Page, label: string) => {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: label })
    .or(page.getByRole("button", { name: label }))
    .first()
    .click();
  await expect(page.getByRole("heading", { name: label, level: 2 }).first()).toBeVisible();
};
const scrollToEnd = (page: Page) =>
  page.locator("[data-slot=settings-body]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
const typeCode = async (page: Page) => {
  await page.goto("/pair");
  await page.getByLabel("Pairing code").fill(PAIR_CODE);
};
const verifyTypedCode = async (page: Page) => {
  await typeCode(page);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("heading", { name: "Check the host's key" })).toBeVisible();
};
const refusedWith = (closeCode: number) => async (page: Page) => {
  await fakeRelay(page, closeCode);
  await verifyTypedCode(page);
  await page.getByRole("button", { name: "They match" }).click();
  await expect(page.getByText("Pairing did not finish")).toBeVisible({ timeout: 15_000 });
};
const SETTINGS = ["Appearance", "Terminal", "Keybindings"] as const;
/** The mesh panel once its document and the added machine it is checked against have both arrived. */
const meshLoaded = async (page: Page) => {
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
  await section(page, "Mesh");
  await expect(page.locator('[data-mesh-group="pending"] [data-mesh-answer]').first()).toBeVisible({ timeout: 20_000 });
};

export const SHOTS: readonly Shot[] = [
  {
    name: "first-run",
    start: "none",
    run: async (page) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Connect to a host" })).toBeVisible();
    },
  },
  {
    name: "pair",
    start: "pairing",
    run: async (page) => {
      await page.goto("/pair");
      await expect(page.getByRole("heading", { name: "Pair this device" })).toBeVisible();
    },
  },
  { name: "pair-code", start: "pairing", run: typeCode },
  {
    name: "pair-code-verify",
    start: "pairing",
    run: async (page) => {
      await fakeRelay(page, 4410);
      await verifyTypedCode(page);
    },
  },
  {
    name: "pair-verify",
    start: "pairing",
    run: async (page) => {
      await page.goto(PAIR_LINK);
      await expect(page.getByRole("heading", { name: "Check the host's key" })).toBeVisible();
    },
  },
  {
    name: "pair-link-invalid",
    start: "pairing",
    run: async (page) => {
      await page.goto(BAD_LINK);
      await expect(page.getByText("This pairing link cannot be used")).toBeVisible();
    },
  },
  {
    name: "pair-mismatch",
    start: "pairing",
    run: async (page) => {
      await page.goto(PAIR_LINK);
      await page.getByRole("button", { name: "They don't match" }).click();
      await expect(page.getByText("Do not pair with this host")).toBeVisible();
    },
  },
  {
    name: "pair-code-mismatch",
    start: "pairing",
    run: async (page) => {
      await fakeRelay(page, 4410);
      await verifyTypedCode(page);
      await page.getByRole("button", { name: "They don't match" }).click();
      await expect(page.getByText("Do not pair with this host")).toBeVisible();
    },
  },
  { name: "pair-refused-4410", start: "pairing", run: refusedWith(4410) },
  { name: "pair-refused-4429", start: "pairing", run: refusedWith(4429) },
  {
    name: "workspace",
    start: "connected",
    run: async (page, width) => {
      await page.goto("/");
      if (width === "390") return void (await expect(page.getByText("Needs you")).toBeVisible());
      await openTerminal(page, /shell/, "$");
      await openTerminal(page, /deploy/, "Waiting for approval");
      await page.getByRole("button", { name: "Split" }).click();
      // Hidden tabs stay mounted, so only the two shown panes count.
      await expect(page.locator("[data-terminal]:visible")).toHaveCount(2);
      await expect(page.locator("[data-terminal]:visible").filter({ hasText: "$" })).toBeVisible();
    },
  },
  {
    name: "terminal",
    start: "connected",
    run: async (page, width) => {
      await page.goto("/");
      if (width === "1440") return openTerminal(page, /shell/, "$");
      await page
        .getByRole("button", { name: /deploy/ })
        .first()
        .click();
      await expect(page.locator("[data-terminal]")).toContainText("Waiting for approval", { timeout: 15_000 });
    },
  },
  {
    name: "palette",
    start: "connected",
    run: async (page) => {
      await page.goto("/");
      await expect(page.getByText("Needs you").first()).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Command palette" }).first().click();
      await expect(page.getByRole("combobox", { name: "Command" })).toBeFocused();
    },
  },
  {
    name: "settings",
    start: "connected",
    run: async (page) => {
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Connection", level: 2 })).toBeVisible();
    },
  },
  ...SETTINGS.map((label): Shot => ({
    name: `settings-${label.toLowerCase()}`,
    start: "connected",
    run: (page) => section(page, label),
  })),
  ...SETTINGS.map((label): Shot => ({
    name: `settings-${label.toLowerCase()}-end`,
    start: "connected",
    run: async (page) => {
      await section(page, label);
      await scrollToEnd(page);
    },
  })),
  { name: "settings-mesh", start: "connected", run: meshLoaded },
  {
    name: "settings-mesh-end",
    start: "connected",
    run: async (page) => {
      await meshLoaded(page);
      await scrollToEnd(page);
    },
  },
  {
    name: "storage-error",
    start: "connected",
    storageFails: true,
    run: async (page) => {
      await section(page, "Terminal");
      await expect(page.getByRole("alert").first()).toBeVisible();
    },
  },
  {
    name: "storage-error-keybindings",
    start: "connected",
    storageFails: true,
    run: async (page) => {
      await section(page, "Keybindings");
      await expect(page.getByRole("alert").first()).toBeVisible();
    },
  },
];
