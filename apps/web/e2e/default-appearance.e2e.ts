import { expect, openNewTerminal, test } from "./fixtures.ts";

// A light device: the default must still be dark, so the device's own preference cannot be what makes it dark.
test.use({ serviceWorkers: "block", colorScheme: "light" });

for (const viewport of [{ name: "desktop", width: 1280, height: 720 }] as const) {
  test(`a first visit on a light ${viewport.name} opens in the dark Night theme with a monospace terminal`, async ({
    page,
  }) => {
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
    await openNewTerminal(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const terminal = page.locator('[data-focused="true"] [data-terminal]');
    await expect(terminal).toContainText("$");
    const text = await page
      .locator(".term-row")
      .first()
      .evaluate((row) => {
        const style = getComputedStyle(row);
        return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight };
      });
    console.log(`${viewport.name} ${viewport.width}px: ${text.size} / line ${text.lineHeight} / ${text.family}`);
    expect(text.family).toContain("JetBrains Mono");
    expect(parseFloat(text.size)).toBeGreaterThanOrEqual(12);
  });
}
