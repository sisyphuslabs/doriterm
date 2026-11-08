import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// A touch device takes the coarse type sizes; 320 is the narrowest phone width the app supports.
test.use({ ...phone, viewport: { width: 320, height: 640 }, serviceWorkers: "block" });

endOwnTerminals();

const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const states = (page: Page) => dialog(page).getByRole("group", { name: "Show agents" });

function startShell(name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** hc refuses to type into a blocked terminal unless forced. */
function report(address: string, state: string): void {
  hcOn("host", ["send", "--force", address, `printf '\\033]7501;state=${state}\\033\\\\'`]);
}

test("on a 320 px touch phone the palette shows All and the two most urgent states, which fit with room (#1454)", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const shells = ["blocked", "working", "done"].map((state) => ({ state, address: startShell(`pst-${state}-${run}`) }));
  for (const { address, state } of shells) report(address, state);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`pst-done-${run}`)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Command palette" }).click();
  await expect(states(page).getByRole("button")).toHaveCount(3, { timeout: 15_000 });
  await expect(states(page).getByRole("button", { name: /^Done / })).toHaveCount(0);
  const frame = await dialog(page).boundingBox();
  expect(frame).not.toBeNull();
  const segments = await states(page)
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, clipped: button.scrollWidth > button.clientWidth };
      }),
    );
  for (const box of segments) {
    expect(box.left).toBeGreaterThanOrEqual(frame?.x ?? 0);
    expect(box.right).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.width ?? 0));
    expect(box.clipped).toBe(false);
  }
  // Fonts differ by platform (CI's Linux fonts set this row ~8% wider than a Mac's), so the segments keep a tenth of the
  // row's room free: a row that just fits here spills on another phone.
  const room = await states(page).evaluate((group) => {
    const holder = group.parentElement;
    if (holder === null) return 0;
    const style = getComputedStyle(holder);
    const gaps = getComputedStyle(group);
    const inner = holder.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    const chrome =
      Number.parseFloat(gaps.paddingLeft) +
      Number.parseFloat(gaps.paddingRight) +
      Number.parseFloat(gaps.borderLeftWidth) +
      Number.parseFloat(gaps.borderRightWidth) +
      Number.parseFloat(gaps.columnGap || "0") * (group.children.length - 1);
    return inner - chrome;
  });
  const text = await states(page)
    .getByRole("button")
    .evaluateAll((buttons) => buttons.reduce((sum, button) => sum + button.scrollWidth, 0));
  expect(text).toBeLessThanOrEqual(room * 0.9);
  for (const { address } of shells) report(address, "working");
});
