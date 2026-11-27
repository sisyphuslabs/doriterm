// Phone terminal header's compact needs-you pill (#2863): shows other blocked agents without leaving the terminal,
// keeps a 44x44 touch target and header fit at 390 px and at 320 px, and jumps to the blocked agent on tap.
import type { Locator, Page } from "@playwright/test";
import { agentRow, endAgent, startAgent, startShell } from "./agents.ts";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { PHONE } from "./phone-key-bar.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...PHONE, serviceWorkers: "block" });

const header = (page: Page) => page.getByRole("banner");

// The spec seeds its own shell and a blocked agent, so it never depends on what other specs leave running.
const TAG = "pny-" + Date.now().toString(36);
let seeded: string[] = [];
test.afterEach(() => {
  for (const address of seeded) endAgent("host", address);
  seeded = [];
});

/** Seeds a shell and a blocked agent, opens the shell, and returns how many agents need you (the Needs you count). */
async function openShellBesideBlocked(page: Page, suffix: string): Promise<number> {
  seeded = [startShell("host", `${TAG}-${suffix}-shell`), startAgent("host", `${TAG}-${suffix}-wait`, "blocked")];
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  const needsYouSection = page.getByRole("region", { name: "Needs you", exact: true });
  await expect(needsYouSection).toBeVisible({ timeout: 20_000 });
  const totalBlocked = Number(((await needsYouSection.locator("header [data-numeric]").textContent()) ?? "").trim());
  expect(totalBlocked).toBeGreaterThanOrEqual(1);

  await agentRow(page, `${TAG}-${suffix}-shell`, false).click();
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
  return totalBlocked;
}

// The header's second line also says Reconnecting while the host link is down (#2887): with the pill beside a long title,
// that line takes the place of the machine and space, and the header still never grows.
for (const width of [390, 320]) {
  test(`at ${width} px a dropped link reads Reconnecting in the header beside the pill, and the header stays 48 px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const socket = await routeHcSocket(page);
    const totalBlocked = await openShellBesideBlocked(page, `${width}-relink`);
    const bar = header(page);
    await expect(
      bar.getByRole("button", { name: `${totalBlocked} needs you, open the next`, exact: true }),
    ).toBeVisible();
    await expectHeaderNoTaller(bar);

    await socket.drop(true);
    await expect(bar.locator("[data-header-reconnecting]")).toBeVisible({ timeout: 5_000 });
    await expectHeaderNoTaller(bar);
    expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    socket.restore();
    await expect(bar.locator("[data-header-reconnecting]")).toHaveCount(0, { timeout: 20_000 });
  });
}

/**
 * The pill never costs the terminal a row (#2865): beside it the title keeps one line, ending in an ellipsis, and the
 * header stays at its 48 px minimum, as tall as without the pill for a title that fits one line.
 */
async function expectHeaderNoTaller(bar: Locator): Promise<void> {
  const lines = await bar.locator("[data-title-lines]").evaluate((el) => (el.textContent ?? "").split("\n"));
  expect(lines).toHaveLength(1);
  await expect.poll(async () => (await laidOutBox(bar)).height).toBe(48);
}

test("at 390 px the phone header shows a tappable compact needs-you pill that opens the blocked agent", async ({
  page,
}) => {
  const totalBlocked = await openShellBesideBlocked(page, "390-longtitle");

  const bar = header(page);
  const pill = bar.getByRole("button", { name: `${totalBlocked} needs you, open the next`, exact: true });
  await expect(pill).toBeVisible();
  await expectHeaderNoTaller(bar);
  // The 32-character title is wider than its column: it ends in an ellipsis instead of taking a second line.
  await expect(bar.locator("[data-title-lines]")).toHaveText(/\u2026$/);

  const pillBox = await laidOutBox(pill);
  expect(pillBox.height).toBeGreaterThanOrEqual(24);
  const hitBox = await pill.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return { width: Number.parseFloat(after.width), height: Number.parseFloat(after.height) };
  });
  expect(hitBox.width).toBeGreaterThanOrEqual(44);
  expect(hitBox.height).toBeGreaterThanOrEqual(44);
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await pill.tap();
  // The pill opens a blocked agent: the header no longer names the shell.
  await expect(bar.getByRole("heading", { level: 1, name: TAG + "-390-longtitle-shell", exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });

  const remaining = totalBlocked - 1;
  if (remaining === 0) {
    await expect(bar.getByRole("button", { name: /needs you, open the next$/ })).toHaveCount(0);
  } else {
    await expect(bar.getByRole("button", { name: `${remaining} needs you, open the next`, exact: true })).toBeVisible();
  }
});

// DESIGN.md (e): 320 px is the tight case. The pill is one more trailing control, yet the header still fits the width
// and the title column keeps at least 96 px: the room it has at 320 with Back, the pill, a header action (the mic) and
// the session menu all drawn at 44 px.
test("at 320 px the phone header keeps the needs-you pill and the title column fits beside it", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const totalBlocked = await openShellBesideBlocked(page, "320");

  const bar = header(page);
  const pill = bar.getByRole("button", { name: `${totalBlocked} needs you, open the next`, exact: true });
  await expect(pill).toBeVisible();
  expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expectHeaderNoTaller(bar);

  const title = bar.getByRole("heading", { level: 1, name: TAG + "-320-shell", exact: true });
  const [titleBox, pillBox, barBox] = [await laidOutBox(title), await laidOutBox(pill), await laidOutBox(bar)];
  expect(titleBox.width).toBeGreaterThanOrEqual(96);
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(pillBox.x);
  expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(barBox.x + barBox.width);
});
