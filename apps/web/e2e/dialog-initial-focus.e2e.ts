// A question opens with no default answer: focus lands on the dialog itself (named by its title), so Enter neither
// cancels nor confirms, and Tab reaches Cancel first. A dialog with a field still opens in that field (#1495).
import { endAgent } from "./agents.ts";
import { SHOTS, type Width } from "./capture-shots.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

test.use({ serviceWorkers: "block" });

for (const width of ["390", "1440"] as const satisfies readonly Width[]) {
  test.describe(`${width}`, () => {
    test.use({
      viewport: { width: Number(width), height: width === "390" ? 844 : 900 },
      hasTouch: width === "390",
      isMobile: width === "390",
    });

    // The shot opens the question at desktop width; at 390 it then narrows the window, so that case proves focus stays
    // on the dialog through the resize, not where a phone-opened question starts.
    test("Close space? has focus on the dialog, Enter answers nothing and Tab reaches Cancel", async ({ page }) => {
      const shot = SHOTS.find((entry) => entry.name === "space-close-dialog" && entry.only === width);
      if (shot === undefined) throw new Error("capture space-close-dialog is missing");
      try {
        await shot.run(page, width);
        const ask = page.getByRole("dialog", { name: "Close space?" });
        await expect(ask).toBeFocused();
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BUTTON");

        await page.keyboard.press("Enter");
        await expect(ask).toBeVisible();
        await page.keyboard.press("Tab");
        await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused();
        await expect(ask).toBeVisible();
      } finally {
        shot.cleanup?.();
      }
    });
  });
}

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

test("Rename still opens with focus in its Name field", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = `rn1495-${test.info().repeatEachIndex}`;
  const out: unknown = JSON.parse(
    hcOn("host", ["run", "--bg", "--name", "rn-one", "--label", `space=${name}`, "--", "sh"]),
  );
  if (typeof out !== "object" || out === null || !("address" in out)) throw new Error(String(out));
  started.push(String(out.address));
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Workspace" });
  await sidebar.getByRole("button", { name: new RegExp(`^${name}(?: |$)`) }).hover({ timeout: 20_000 });
  await sidebar.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Rename space\u2026" }).click();
  await expect(page.getByRole("dialog", { name: `Rename ${name}` }).getByRole("textbox")).toBeFocused();
});
