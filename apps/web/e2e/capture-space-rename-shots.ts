import type { Page } from "@playwright/test";
import type { Shot } from "./capture-shots.ts";
import { expect } from "./fixtures.ts";

/** The seeded `website` space (seed.ts), named by its terminals' `space=website` label. */
const website = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("button", { name: /^website\b/ });

/** Renaming a space (#395): in place after a double-click, and the Rename question from its "..." menu. */
export const SPACE_RENAME_SHOTS: readonly Shot[] = [
  {
    name: "space-rename-inline",
    start: "connected",
    only: "1440",
    run: async (page) => {
      await page.goto("/");
      await website(page).dblclick({ timeout: 15_000 });
      const field = page.getByRole("textbox", { name: "Rename space website" });
      await expect(field).toBeFocused();
      await field.fill("storefront");
    },
  },
  {
    name: "space-rename-dialog",
    start: "connected",
    only: "1440",
    run: async (page) => {
      await page.goto("/");
      await website(page).hover({ timeout: 15_000 });
      await page.getByRole("button", { name: "More for website" }).click();
      await page.getByRole("menuitem", { name: "Rename space…" }).click();
      await expect(page.getByRole("dialog", { name: "Rename website" }).getByRole("textbox")).toBeFocused();
    },
  },
];
