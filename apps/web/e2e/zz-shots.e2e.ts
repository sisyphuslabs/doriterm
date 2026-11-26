import { expect, test } from "./fixtures.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });
const OUT = process.env["SHOT_DIR"] ?? "/tmp";
for (const width of [390, 412]) {
  for (const scheme of ["dark", "light"] as const) {
    test(`shots ${width} ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const terminal = await openPhoneTerminal(page, width);
      await page.keyboard.type("echo hello-from-the-card");
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("hello-from-the-card");
      await page.screenshot({ path: `${OUT}/keys-${width}-${scheme}.png` });
      await keysBar(page).getByRole("button", { name: "Type in a field", exact: true }).click();
      await page.screenshot({ path: `${OUT}/card-${width}-${scheme}.png` });
      await keysBar(page).getByRole("button", { name: "Type in a field", exact: true }).click();
      await key(page, "Arrow keys").scrollIntoViewIfNeeded();
      await key(page, "Arrow keys").click();
      await page.screenshot({ path: `${OUT}/pad-${width}-${scheme}.png` });
    });
  }
}
