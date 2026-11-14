import { devices, type Page } from "@playwright/test";
import { endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { fakeSoftKeyboard, key, keysBar, openShortcutPacks, showKeyboard } from "./phone-key-bar.ts";

// A touch phone: the keyboard toggle has to follow the keyboard itself, not the terminal's focus (#274), and opening a
// terminal raises no keyboard of its own — only the keyboard button does (#1375). A mouse-only window of this width
// opens the keys bar by hand instead (phone-keys-mouse.e2e.ts, #287).
test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openTerminal(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return { input: page.locator("[data-terminal] textarea") };
}

async function expectDown(page: Page): Promise<void> {
  // The keys stay on screen with the keyboard down; their toggle reads Show keyboard (#2499).
  await expect(keysBar(page).getByRole("button", { name: "Show keyboard", exact: true })).toBeVisible();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);
}

async function expectUp(page: Page): Promise<void> {
  await expect(keysBar(page)).toBeVisible();
  await expect(key(page, "Hide keyboard")).toBeVisible();
  await expect(key(page, "Show keyboard")).toHaveCount(0);
}

test("opening a terminal raises no keyboard on its own: it stays down until the keyboard button asks for it (#1375)", async ({
  page,
}) => {
  // A phone whose keyboard rises for any focus: an opening that focuses the terminal raises it, as it did.
  await fakeSoftKeyboard(page);
  const { input } = await openTerminal(page);
  await expect(input).not.toBeFocused();
  await expectDown(page);

  // A press in the terminal is not a request for the keyboard: the field takes the focus, the keyboard stays down.
  await page.locator("[data-terminal]").click();
  await expect(input).toBeFocused();
  await expectDown(page);

  await key(page, "Show keyboard").click();
  await expect(input).toBeFocused();
  await expectUp(page);

  await key(page, "Hide keyboard").click();
  await expectDown(page);
  await expect(input).not.toBeFocused();
});

test("a session picked from Switch session raises no keyboard: only the keyboard button does, then and after the system Back", async ({
  page,
}) => {
  const first = startShell("host", "pickone");
  const second = startShell("host", "picktwo");
  try {
    await fakeSoftKeyboard(page);
    await page.goto("/");
    const one = page.getByRole("button", { name: /pickone/ }).first();
    await expect(one).toBeVisible({ timeout: 20_000 });
    await one.click();
    await expect(page.locator(`[data-terminal="${first}"]`)).toContainText("$", { timeout: 15_000 });
    await key(page, "Show keyboard").click();
    await expectUp(page);

    // Picking a session opens it with the keyboard down, per the product owner: the keyboard button is the only ask.
    await key(page, "Switch session").click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: /picktwo/ })
      .click();
    const picked = page.locator(`[data-terminal="${second}"]`);
    await expect(picked).toContainText("$", { timeout: 15_000 });
    await expect(picked.locator("textarea")).not.toBeFocused();
    await expectDown(page);

    // The system Back leaves it without the app's own Back button; opening it again from the list is no new ask.
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await page
      .getByRole("button", { name: /picktwo/ })
      .first()
      .click();
    await expect(picked).toContainText("$", { timeout: 15_000 });
    await expect(picked.locator("textarea")).not.toBeFocused();
    await expectDown(page);
  } finally {
    endAgent("host", first);
    endAgent("host", second);
  }
});

test("Show keyboard on a field focused for typing outside a tap still asks for the keyboard, and the program hears no focus-out (#1519)", async ({
  page,
}) => {
  // A program that asks for focus reports (mode 1004) and shows what it is sent: `cat -v` writes a focus-out as ^[[O.
  const report = "printf 'reporting\\n\\033[?1004h'; exec cat -v";
  const out = hcOn("host", ["run", "--bg", "--name", "keysfocus", "--label", "space=api", "--", "sh", "-c", report]);
  const address = String((JSON.parse(out) as { address: string }).address);
  try {
    // A keyboard that no focus raises by itself, as on iOS: a field can keep the focus in text mode with no keyboard up.
    await fakeSoftKeyboard(page, { raiseOnFocus: false });
    await page.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { fieldFocus: seen });
      document.addEventListener("focusout", (event) => {
        if (event.target instanceof HTMLTextAreaElement && event.target.closest("[data-terminal]")) seen.push("out");
      });
    });
    await page.goto("/");
    const row = page.getByRole("button", { name: /keysfocus/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const picked = page.locator(`[data-terminal="${address}"]`);
    const field = picked.locator("textarea");
    await expect(picked).toContainText("reporting", { timeout: 15_000 });

    // The state comes from the app's own path (#2036): closing the Shortcut packs sheet gives the terminal the focus
    // back for typing a frame later, outside any tap's gesture, so no keyboard comes up. The sheet opens from a held
    // Ctrl on the keys bar, which is up only with the keyboard; the sheet takes the focus, and the keyboard goes with it.
    await key(page, "Show keyboard").click();
    await showKeyboard(page, 336);
    await expectUp(page);
    await openShortcutPacks(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Shortcut packs" })).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("inputmode", "text");
    await expectDown(page);
    // What the program was told so far ends in a line of its own, so the press's reports, if any, come after it. Read in
    // the grid alone: the terminal also mirrors its text for assistive tech, and the two copies need not update together.
    const grid = picked.locator(".term-grid");
    await page.keyboard.type("before\r");
    await expect(grid).toContainText("before");
    const outs = async (): Promise<number> => ((await grid.textContent()) ?? "").split("^[[O").length - 1;
    const outsBefore = await outs();

    // The press lets the field go and takes it again inside the tap, which is what raises a keyboard on iOS; the
    // program is not told the terminal lost the focus.
    await page.evaluate(() => (Reflect.get(window, "fieldFocus") as string[]).splice(0));
    await key(page, "Show keyboard").click();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("inputmode", "text");
    expect(await page.evaluate(() => Reflect.get(window, "fieldFocus") as string[])).toEqual(["out"]);
    await page.keyboard.type("done\r");
    await expect(grid).toContainText("done");
    expect(await outs()).toBe(outsBefore);
  } finally {
    endAgent("host", address);
  }
});

const { defaultBrowserType: _iphoneBrowser, ...IPHONE } = devices["iPhone 14"];
const { defaultBrowserType: _pixelBrowser, ...PIXEL } = devices["Pixel 7"];
const phone = (browserName: string) => (browserName === "webkit" ? IPHONE : PIXEL);

/**
 * A finger on a phone, as each engine stands for one (#1409): WebKit, the engine iOS uses, is an iPhone and Chromium a
 * Pixel. Run with `E2E_BROWSERS=all --project=chromium --project=webkit` for both; the default run is Chromium alone.
 */
test.describe("a finger on a phone", () => {
  test.use({
    userAgent: async ({ browserName }, use) => use(phone(browserName).userAgent),
    deviceScaleFactor: async ({ browserName }, use) => use(phone(browserName).deviceScaleFactor),
    isMobile: async ({ browserName }, use) => use(phone(browserName).isMobile),
    hasTouch: async ({ browserName }, use) => use(phone(browserName).hasTouch),
  });

  test("a finger's tap on the terminal asks for no keyboard, the keyboard button does, and a tap on the Type field keeps it up (#1375)", async ({
    page,
  }) => {
    // A real touch sequence (touchstart/touchend, then the synthesized click), as a phone's browser delivers a tap. What
    // decides the soft keyboard on iOS is the focused field's `inputmode`, so the assertions read that attribute as well
    // as the keys bar.
    await fakeSoftKeyboard(page);
    const { input } = await openTerminal(page);
    const box = await page.locator("[data-terminal]").boundingBox();
    if (box === null) throw new Error("the terminal is not laid out");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("inputmode", "none");
    await expectDown(page);

    await key(page, "Show keyboard").tap();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("inputmode", "text");
    await expectUp(page);

    // The keyboard button puts it down again, and the field asks for none until the button asks again.
    await key(page, "Hide keyboard").tap();
    await expectDown(page);
    await expect(input).toHaveAttribute("inputmode", "none");
    await key(page, "Show keyboard").tap();
    await expect(input).toHaveAttribute("inputmode", "text");
    await expectUp(page);

    // The Type field rides on the keys bar, so it is on the page only while the keyboard is up (the #1409 spec checks it
    // goes with the keyboard): there is no down state to raise the keyboard from. What a tap on it can prove is that the
    // focus leaves the terminal for a field that asks for a keyboard: this fake lowers the keyboard on any focus move that
    // does not land on a textarea without `inputmode="none"` (phone-key-bar.ts), so the keyboard is up after the move only
    // because the Type field is such a textarea. (`getAttribute`, since `inputMode` is not on `HTMLElement | SVGElement`.)
    const field = page.getByLabel("Type into the terminal");
    await field.tap();
    await expect(field).toBeFocused();
    await expect(input).not.toBeFocused();
    await expectUp(page);
    expect(
      await field.evaluate((el) => el.closest("[data-terminal]") === null && el.getAttribute("inputmode") !== "none"),
    ).toBe(true);
  });

  test("after a tap in the terminal, Show keyboard lets the field go on its pointerdown and takes it on its click, a tap apart (#1940)", async ({
    page,
  }) => {
    // A field a tap focused (in `none` mode, so no keyboard came up) has an input session open on iOS. Let go and taken
    // back in ONE task (a blur and a focus inside the click, whichever of the button's mousedown or the port's own
    // blur let it go), WebKit keeps the pair in the web process and the keyboard never rises; the press has to let the
    // field go on its pointerdown, which the finger's landing delivers, a task before the click its lifting delivers.
    // So the trace reads which of the tap's events the field's focus moved in.
    await fakeSoftKeyboard(page);
    await page.addInitScript(() => {
      const trace: { on: string; mode: string }[] = [];
      let last = "";
      for (const type of ["pointerdown", "touchstart", "touchend", "mousedown", "click"]) {
        document.addEventListener(
          type,
          () => {
            last = type;
          },
          true,
        );
      }
      const moved = (event: FocusEvent, way: string): void => {
        if (!(event.target instanceof HTMLTextAreaElement) || event.target.closest("[data-terminal]") === null) return;
        trace.push({ on: `${way}:${last}`, mode: event.target.inputMode });
      };
      document.addEventListener("focusout", (event) => moved(event, "out"), true);
      document.addEventListener("focusin", (event) => moved(event, "in"), true);
      Object.assign(window, { fieldFocusTrace: trace });
    });
    const { input } = await openTerminal(page);
    const box = await page.locator("[data-terminal]").boundingBox();
    if (box === null) throw new Error("the terminal is not laid out");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("inputmode", "none");
    await expectDown(page);

    const trace = () => page.evaluate(() => Reflect.get(window, "fieldFocusTrace") as { on: string; mode: string }[]);
    await page.evaluate(() => (Reflect.get(window, "fieldFocusTrace") as unknown[]).splice(0));
    await key(page, "Show keyboard").tap();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("inputmode", "text");
    await expectUp(page);
    expect(await trace()).toEqual([
      { on: "out:pointerdown", mode: "none" },
      { on: "in:click", mode: "text" },
    ]);
  });
});

test("with the terminal focused and no keyboard up, the toggle reads Show keyboard; it reads Hide keyboard only while one covers the page", async ({
  page,
}) => {
  await fakeSoftKeyboard(page, { raiseOnFocus: false });
  const { input } = await openTerminal(page);
  // The button is what puts the focus in the terminal, now (#1375).
  await key(page, "Show keyboard").click();
  await expect(input).toBeFocused();
  await expectDown(page);

  await showKeyboard(page, 336);
  await expectUp(page);

  // Closed by its own key (Android back, the iPad hide key): Show keyboard again, and the terminal lets go of the focus.
  await showKeyboard(page, 0);
  await expectDown(page);
  await expect(input).not.toBeFocused();
});

test("a browser that shrinks the page for the keyboard: Show keyboard while it is down, Hide keyboard while it is up", async ({
  page,
}) => {
  const { input } = await openTerminal(page);
  await expect(input).not.toBeFocused();
  await expectDown(page);

  // A press in the terminal leaves the keyboard down (#1375); the button raises it, and this browser shrinks the page for it.
  await page.locator("[data-terminal]").click();
  await expect(input).toBeFocused();
  await expectDown(page);
  await key(page, "Show keyboard").click();
  await page.setViewportSize({ width: 390, height: 844 - 336 });
  await expectUp(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectDown(page);
  await expect(input).not.toBeFocused();
});

test("Hide keyboard and a tap outside put it down, Show keyboard brings it up, and the toggle says which each time", async ({
  page,
}) => {
  await fakeSoftKeyboard(page);
  const { input } = await openTerminal(page);
  // Nothing raises the keyboard on opening; the button does (#1375).
  await expectDown(page);

  await key(page, "Show keyboard").click();
  await expectUp(page);
  await expect(input).toBeFocused();

  await key(page, "Hide keyboard").click();
  await expectDown(page);
  await expect(input).not.toBeFocused();

  await key(page, "Show keyboard").click();
  await expectUp(page);
  await expect(input).toBeFocused();

  // A tap outside the terminal (its header) takes the focus, and with it the keyboard.
  await page.getByRole("banner").getByRole("heading").click();
  await expectDown(page);
});
