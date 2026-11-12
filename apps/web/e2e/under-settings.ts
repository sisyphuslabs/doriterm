import type { Page } from "@playwright/test";

/** The workspace kept under Settings (#607), by its own mark: a check that found it by `inert` passed once that went (#1885). */
const workspace = (page: Page) => page.locator("[data-workspace]");

/** Every element of the workspace whose own computed visibility would paint it; it throws when the workspace is gone. */
export const drawnUnderSettings = (page: Page) =>
  workspace(page).evaluate((root) =>
    [...root.querySelectorAll("*")]
      .filter((element) => getComputedStyle(element).visibility !== "hidden")
      .map((element) => element.getAttribute("aria-label") ?? element.tagName.toLowerCase()),
  );

/** Whether the workspace is out of reach while Settings is open: what the check above no longer takes for granted. */
export const workspaceInert = (page: Page) => workspace(page).evaluate((root) => root.hasAttribute("inert"));
