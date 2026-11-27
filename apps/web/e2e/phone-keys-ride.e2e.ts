import { expect, test } from "./fixtures.ts";
import { atRest } from "./at-rest.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { restingBottom, rideMotion } from "./motion-watch.ts";
import { key, keysBar, openPhoneTerminal, PHONE, showKeyboard } from "./phone-key-bar.ts";

// The redesign's second motion pass (#2875, #2539): the phone's keys panel rides with the soft keyboard by a transform
// on the #2796 tokens, docking under the terminal as the keyboard goes.

test.use({ serviceWorkers: "block" });

test.describe("a touch phone", () => {
  test.use(PHONE);

  endOwnTerminals();

  test("the keys panel rides up with the keyboard by a transform (#2539)", async ({ page }) => {
    await openPhoneTerminal(page);
    await showKeyboard(page, 0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
    const ride = await rideMotion(page);
    await page.getByRole("button", { name: "Show keyboard" }).click();
    expect((await ride()).map(({ what, duration }) => ({ what, duration }))).toEqual([
      { what: "transform", duration: 240 },
    ]);
  });

  test("the keys panel rides down to its dock as the keyboard goes", async ({ page }) => {
    await openPhoneTerminal(page);
    await expect(page.getByRole("button", { name: "Hide keyboard" })).toBeVisible();
    const ride = await rideMotion(page);
    await page.getByRole("button", { name: "Hide keyboard" }).click();
    const [down] = await ride();
    expect(down?.what).toBe("transform");
    expect(down?.duration).toBe(240);
    expect(down?.from).toBeLessThan(0);
  });

  test("after the window resizes, the next ride starts where the panel stands", async ({ page }) => {
    await openPhoneTerminal(page);
    await showKeyboard(page, 0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
    // Shorter by less than any keyboard, as a browser's toolbar or a rotation makes it: the panel moves without a ride.
    const tall = await restingBottom(page);
    await page.setViewportSize({ width: 390, height: 724 });
    await expect.poll(() => restingBottom(page)).toBeLessThan(tall);
    const before = await restingBottom(page);
    expect(before).toBeLessThanOrEqual(724);

    const ride = await rideMotion(page);
    await page.getByRole("button", { name: "Show keyboard" }).click();
    const [up] = await ride();
    const after = await restingBottom(page);
    expect(up?.what).toBe("transform");
    expect(Math.abs((up?.from ?? 0) - (before - after))).toBeLessThanOrEqual(1);
  });

  test("a key tapped mid-ride, where it is drawn, is sent once and nothing else is hit", async ({ page }) => {
    const terminal = await openPhoneTerminal(page);
    // cat -t shows a tab as ^I; with echo off, each line the program prints is its one copy of what it was sent.
    await page.keyboard.type("stty -echo; cat -vt\r");
    await atRest(page);
    // The keyboard closes by its own key and the panel rides down to its dock. The watch is armed before the keyboard
    // moves, and catches the ride as the panel's move lands (its layout effect starts the ride in that same commit);
    // the ride is held at 120 ms of its 240 while Tab is hit where it is drawn.
    const point = await key(page, "Tab").evaluate(
      (button) =>
        new Promise<{ readonly x: number; readonly y: number }>((resolve, reject) => {
          const panel = button.closest('[role="toolbar"]')?.parentElement;
          if (!(panel instanceof HTMLElement)) throw new Error("no keys panel");
          new MutationObserver((_records, observer) => {
            const [ride] = panel.getAnimations();
            if (ride === undefined) return;
            observer.disconnect();
            ride.pause();
            ride.currentTime = 120;
            const { x, y, width, height } = button.getBoundingClientRect();
            resolve({ x: x + width / 2, y: y + height / 2 });
          }).observe(panel, { attributes: true });
          const closeKeyboard = Reflect.get(window, "softKeyboard");
          if (typeof closeKeyboard !== "function") reject(new Error("no fake keyboard"));
          else closeKeyboard(0);
        }),
    );
    await page.touchscreen.tap(point.x, point.y);
    await keysBar(page).evaluate((toolbar) => {
      for (const ride of toolbar.parentElement?.getAnimations() ?? []) ride.play();
    });
    await atRest(page);
    await page.locator("[data-terminal] textarea").focus();
    await page.keyboard.type("q\r");
    await expect(terminal.locator(".term-row").filter({ hasText: /^\^Iq\s*$/ })).toHaveCount(1, { timeout: 15_000 });
    await expect(terminal.locator(".term-row").filter({ hasText: /\^\[|\^I\^I/ })).toHaveCount(0);
    await expect(key(page, "Control")).toHaveAttribute("aria-pressed", "false");
    await expect(key(page, "Shift")).toHaveAttribute("aria-pressed", "false");
  });

  test("under reduced motion the keys panel takes its place at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPhoneTerminal(page);
    await showKeyboard(page, 0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toBeVisible();
    const ride = await rideMotion(page);
    await page.getByRole("button", { name: "Show keyboard" }).click();
    expect(await ride()).toEqual([]);
  });
});
