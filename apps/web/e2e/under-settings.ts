import type { Page } from "@playwright/test";

/** Every element of the workspace kept under Settings (#607) whose own computed visibility would paint it. */
export const drawnUnderSettings = (page: Page) =>
  page
    .locator("[inert] *")
    .evaluateAll((elements) =>
      elements
        .filter((element) => getComputedStyle(element).visibility !== "hidden")
        .map((element) => element.getAttribute("aria-label") ?? element.tagName.toLowerCase()),
    );
