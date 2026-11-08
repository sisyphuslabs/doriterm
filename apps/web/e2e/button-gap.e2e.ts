// A Button keeps the gap its caller gives it between icon and label (the desktop Settings nav sets its own).
import { expect, test } from "./fixtures.ts";

test.use({ viewport: { width: 1440, height: 900 } });

test("a Button's own gap between its icon and its label is the one its caller set", async ({ page }) => {
  await page.goto("/settings");
  const mesh = page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Machines" });
  await expect(mesh).toBeVisible();
  const measured = await mesh.evaluate((button) => {
    const icon = button.querySelector("svg");
    const range = document.createRange();
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text !== null && (text.textContent ?? "").trim() === "") text = walker.nextNode();
    if (icon === null || text === null) return { set: "", gap: -1 };
    range.selectNodeContents(text);
    return {
      set: getComputedStyle(button).columnGap,
      gap: Math.round(range.getBoundingClientRect().left - icon.getBoundingClientRect().right),
    };
  });
  expect(measured).toEqual({ set: "10px", gap: 10 });
});
