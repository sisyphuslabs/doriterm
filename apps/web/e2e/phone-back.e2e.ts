import { devices } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key } from "./phone-key-bar.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

test("the phone's Back returns to the list from a terminal, and only then leaves the app", async ({ page }) => {
  const address = startAgent("host", "backnav", "idle");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /backnav/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).searchParams.get("t")).not.toBeNull();

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();

    const before = page.url();
    await page.goBack();
    await expect.poll(() => page.url()).not.toBe(before);
    await expect(page.getByRole("button", { name: "Back to agents" })).toHaveCount(0);
  } finally {
    endAgent("host", address);
  }
});

test("a switch inside an open terminal still leaves for the list on Back, not the previous tab", async ({ page }) => {
  const first = startAgent("host", "backone", "idle");
  const second = startAgent("host", "backtwo", "idle");
  try {
    await page.goto("/");
    const one = page.getByRole("button", { name: /backone/ }).first();
    await expect(one).toBeVisible({ timeout: 20_000 });
    await one.click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });

    // Back to the list, then into the other terminal: that is the switch the review measured.
    await page.getByRole("button", { name: "Back to agents" }).click();
    const two = page.getByRole("button", { name: /backtwo/ }).first();
    await expect(two).toBeVisible({ timeout: 20_000 });
    await two.click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });

    // A switch replaces the entry instead of adding one, so one Back lands on the list, not on the previous terminal.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();
  } finally {
    endAgent("host", first);
    endAgent("host", second);
  }
});

test("on a desktop, Settings opened over an open terminal keeps it mounted instead of reattaching it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const address = startAgent("host", "backkeep", "idle");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /backkeep/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const terminal = page.locator(`[data-terminal="${address}"]`);
    await expect(terminal).toBeVisible({ timeout: 20_000 });
    // The element itself is the witness: a remount builds a new node and the probe goes with the old one.
    await terminal.evaluate((el) => ((el as HTMLElement).dataset["kept"] = "yes"));

    // Settings is a route with no terminal in it; the workspace stays mounted under it (#607), so the terminal must too,
    // rather than being torn down and reattached by a route that says nothing about which terminal is open.
    // The palette is bound to super+shift+p on macOS and ctrl+shift+p elsewhere, so ask the page which it is.
    const paletteChord = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "Meta" : "Control",
    );
    await page.keyboard.press(`${paletteChord}+Shift+p`);
    const palette = page.getByRole("combobox");
    await expect(palette).toBeVisible({ timeout: 10_000 });
    await palette.fill("Settings");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`[data-terminal="${address}"][data-kept="yes"]`)).toHaveCount(1);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(`[data-terminal="${address}"][data-kept="yes"]`)).toHaveCount(1);
  } finally {
    endAgent("host", address);
  }
});

test("a desktop keeps no history entries when it opens a terminal", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const address = startAgent("host", "deskone", "idle");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /deskone/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.locator(`[data-terminal="${address}"]`)).toBeVisible({ timeout: 20_000 });
    // No phone entry on a wide screen: nothing to pop, so Back cannot step through no-op entries.
    await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();
    const entries = await page.evaluate(() => history.length);
    await page
      .getByRole("button", { name: "New tab" })
      .click()
      .catch(() => undefined);
    await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();
    expect(await page.evaluate(() => history.length)).toBe(entries);
  } finally {
    endAgent("host", address);
  }
});

test("a reload on ?t= reopens the terminal without a second entry, and Back reaches the list", async ({ page }) => {
  const address = startAgent("host", "backreload", "idle");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /backreload/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });
    const entries = await page.evaluate(() => history.length);

    await page.reload();
    await expect(page.locator(`[data-terminal="${address}"]`)).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).searchParams.get("t")).not.toBeNull();
    // The reload must not push a second entry for the same terminal.
    expect(await page.evaluate(() => history.length)).toBe(entries);

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  } finally {
    endAgent("host", address);
  }
});

test("after a reload on ?t=, Back to agents goes down to the list's own entry, so the next Back leaves the app (#1153)", async ({
  page,
}) => {
  const address = startAgent("host", "reloadback", "idle");
  try {
    await page.goto("/");
    const list = page.url();
    const row = page.getByRole("button", { name: /reloadback/ }).first();
    const back = page.getByRole("button", { name: "Back to agents" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(back).toBeVisible({ timeout: 20_000 });

    // The reload forgets that this page pushed the terminal's entry; the entry under it is still the list.
    await page.reload();
    await expect(page.locator(`[data-terminal="${address}"]`)).toBeVisible({ timeout: 20_000 });
    await back.click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    // The same terminal again from that list, and its Back: still one list entry, not one more per visit.
    await row.click();
    await expect(back).toBeVisible({ timeout: 20_000 });
    await back.click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

    await page.goBack();
    await expect.poll(() => page.url(), "no second list entry under the list").not.toBe(list);
  } finally {
    endAgent("host", address);
  }
});

test("a cold open on ?t= comes back to the list instead of leaving the app", async ({ page }) => {
  const address = startAgent("host", "backcold", "idle");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /backcold/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const url = page.url();
    // Straight onto the terminal's own address, with no list behind it in this tab's history.
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });

    // Popping here would leave the app, so the button goes to the list instead.
    await page.getByRole("button", { name: "Back to agents" }).click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();
  } finally {
    endAgent("host", address);
  }
});

test("a switch inside an open terminal replaces its entry, so one Back reaches the list", async ({ page }) => {
  const first = startAgent("host", "switchone", "idle");
  const second = startAgent("host", "switchtwo", "idle");
  try {
    await fakeSoftKeyboard(page);
    await page.goto("/");
    const before = await page.evaluate(() => history.length);
    const one = page.getByRole("button", { name: /switchone/ }).first();
    await expect(one).toBeVisible({ timeout: 20_000 });
    await one.click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => history.length), "entering a terminal adds one entry").toBe(before + 1);

    // Switch session, from inside the open terminal: the switch replaces the entry rather than adding one.
    await key(page, "Show keyboard").click();
    await key(page, "Switch session").click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: /switchtwo/ })
      .click();
    await expect(page.locator(`[data-terminal="${second}"]`)).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => history.length), "the switch adds no entry").toBe(before + 1);

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();
  } finally {
    endAgent("host", first);
    endAgent("host", second);
  }
});

test("at 390, Settings opened from an open terminal keeps it mounted, and Settings after Back mounts none", async ({
  page,
}) => {
  const address = startAgent("host", "backdeep", "idle");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /backdeep/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });
    expect(
      new URL(page.url()).searchParams.get("t"),
      "opening a terminal on a phone names it in the route",
    ).not.toBeNull();
    const terminal = page.locator(`[data-terminal="${address}"]`);
    await terminal.evaluate((el) => ((el as HTMLElement).dataset["kept"] = "yes"));

    // Settings from inside the terminal, an in-app route with no ?t=: the terminal stays mounted (the same node).
    await page.keyboard.press("ControlOrMeta+Shift+KeyP");
    await page.getByRole("combobox", { name: "Command" }).fill("Settings");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator(`[data-terminal="${address}"][data-kept="yes"]`),
      "the terminal is still mounted under Settings",
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(`[data-terminal="${address}"][data-kept="yes"]`)).toHaveCount(1);

    // Back to the list closes the terminal; Settings opened from the list then mounts none under it.
    await page.getByRole("button", { name: "Back to agents" }).click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await page
      .getByRole("link", { name: /Settings/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`[data-terminal="${address}"]`), "no closed terminal under Settings").toHaveCount(0);
  } finally {
    endAgent("host", address);
  }
});
