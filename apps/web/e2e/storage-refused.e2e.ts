import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

// Storage denied by site settings or a sandbox: every read throws, as Chromium does with cookies blocked.
const REFUSE_READS = `Storage.prototype.getItem = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };`;

test("with storage reads refused, the app still starts, with the default appearance and keep-awake off", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript({ content: REFUSE_READS });
  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await nav.getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByLabel("Appearance", { exact: true }).getByRole("button", { name: "System" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute("data-ui-density", "comfortable");
  await nav.getByRole("button", { name: "Device" }).click();
  await expect(page.getByRole("switch", { name: "Keep the screen awake" })).not.toBeChecked();
  expect(errors).toEqual([]);
});
