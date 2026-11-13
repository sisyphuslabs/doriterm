import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { Touch } from "./touch.ts";
import { commandModifier, pressWithCommand } from "./platform-keys.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });

const field = (page: Page) => page.getByLabel("Type into the terminal");
const value = (page: Page) => page.locator("[data-terminal]").evaluate((el) => el.textContent ?? "");

/** Types a Hangul syllable the way the phone's keyboard composes one: the input method owns it until it commits. */
async function compose(page: Page, syllable: string): Promise<void> {
  await page.evaluate((text) => {
    const input = document.querySelector('textarea[aria-label="Type into the terminal"]');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("the input field is not on the page");
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    set?.call(input, `${input.value}${text}`);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: false, data: text }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
  }, syllable);
}

test("the field takes Korean through the input method, and Send writes the line and presses Return", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await field(page).click();
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toBeFocused();

  await page.keyboard.type("echo 인사-$((6*7))");
  await expect(field(page)).toHaveValue("echo 인사-$((6*7))");
  await key(page, "Send").click();
  await expect(field(page)).toHaveValue("");
  await expect(terminal).toContainText("인사-42", { timeout: 15_000 });
  await expect(field(page)).toBeFocused();
});

test("a composed syllable reaches the program as one word, and nothing is sent before Send", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await field(page).click();
  await page.keyboard.type("echo ");
  await compose(page, "한글");
  await expect(field(page)).toHaveValue("echo 한글");
  // The terminal keeps what it had: the field holds the line, not the shell.
  expect(await value(page)).not.toContain("한글");

  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("한글", { timeout: 15_000 });
  await expect(field(page)).toHaveValue("");
});

test("the field stays inside the keys bar, and the keyboard's own key takes both away", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await field(page).click();
  await expect(field(page)).toBeVisible();
  const [box, bar, term] = await Promise.all([
    field(page).boundingBox(),
    keysBar(page).boundingBox(),
    terminal.boundingBox(),
  ]);
  // The field shares the bar's row, and the terminal ends above the bar.
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(bar?.y ?? 0);
  expect((box?.y ?? 0) + (box?.height ?? Infinity)).toBeLessThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0));
  expect((term?.y ?? 0) + (term?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1);

  // Putting the keyboard down keeps the panel, the field's row included (#2499).
  await key(page, "Hide keyboard").click();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);
  await expect(keysBar(page)).toBeVisible();
  await expect(field(page)).toBeVisible();
  await key(page, "Show keyboard").click();
  await expect(keysBar(page)).toBeVisible();
  await expect(field(page)).toBeVisible();
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
});

test("a long line in the field is shown whole, and the keys stay reachable under it", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await field(page).click();
  const line = "echo the quick brown fox jumps over the lazy dog 한글 $((6*7))";
  await page.keyboard.type(line);
  // The field takes the bar's whole width and wraps, so nothing typed is scrolled out of sight.
  const shown = await field(page).evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    hidden: el.scrollWidth - el.clientWidth,
    clipped: el.scrollHeight - el.clientHeight,
  }));
  expect(shown.width).toBeGreaterThan(300);
  expect(shown.hidden).toBeLessThanOrEqual(1);
  expect(shown.clipped).toBeLessThanOrEqual(1);
  // The key row keeps its width: at least six keys in view beside the field.
  const keysInView = await keysBar(page)
    .locator('[data-slot="terminal-keys-scroll"] button')
    .evaluateAll(
      (keys) =>
        keys.filter((button) => {
          const box = button.getBoundingClientRect();
          return box.left >= 0 && box.right <= window.innerWidth && box.width > 0;
        }).length,
    );
  expect(keysInView).toBeGreaterThanOrEqual(6);
  // The terminal ends above the taller bar, so its last row is not under the field.
  const [bar, term] = await Promise.all([keysBar(page).boundingBox(), terminal.boundingBox()]);
  expect((term?.y ?? 0) + (term?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1);
  await key(page, "Send").click();
  await expect(terminal).toContainText("한글 42", { timeout: 15_000 });
});

test("an idle, empty field keeps the pill's 44 pt height, and grows only while in use", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await terminal.click();
  await expect(field(page)).toBeVisible();
  await expect.poll(async () => (await field(page).boundingBox())?.height).toBe(44);
  await field(page).click();
  await page.keyboard.type("echo one two three four five six seven eight nine ten eleven twelve");
  await expect.poll(async () => (await field(page).boundingBox())?.height ?? 0).toBeGreaterThan(44);
});

test("a press held in the terminal while typing gives the keyboard back as it lifts, field and all (#2035)", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await expect(field(page)).toBeVisible();
  const box = await terminal.boundingBox();
  if (box === null) throw new Error("the terminal is not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The press lets the terminal's field go, as one that may select text does, and its lift takes the field back. Held
  // past two frames, as a slow press or a busy page holds it, it is still the same gesture: no dismissal.
  await page.mouse.down();
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await page.mouse.up();
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
  await expect(field(page)).toBeVisible();
});

test("another pointer lifting during a held press in the terminal leaves that press to give the keyboard back (#2093)", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await expect(field(page)).toBeVisible();
  const box = await terminal.boundingBox();
  if (box === null) throw new Error("the terminal is not laid out");
  const frames = (): Promise<void> =>
    page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await frames();
  // A finger swipes across the terminal while the button is still held, and lifts first: its lift is not the press's.
  const finger = await Touch.on(page);
  const from = { x: box.x + 40, y: box.y + 40 };
  const to = { x: box.x + 40, y: box.y + 140 };
  await finger.down(from);
  await finger.drag(from, to);
  await finger.up(to);
  await frames();
  await page.mouse.up();
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
  await expect(field(page)).toBeVisible();
});

test("what is typed in the field is still there after the keyboard closes and opens again", async ({ page }) => {
  await openPhoneTerminal(page);
  await field(page).click();
  await page.keyboard.type("git commit -m 초안");
  // The field stays on screen with the keyboard down (#2499), holding what was typed.
  await key(page, "Hide keyboard").click();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);
  await expect(field(page)).toHaveValue("git commit -m 초안");
  await key(page, "Show keyboard").click();
  await expect(field(page)).toHaveValue("git commit -m 초안");
});

test("Send tapped while a syllable is still composing sends the line once and leaves the field empty", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await field(page).click();
  await page.keyboard.type("echo once-");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
  await expect(field(page)).toHaveValue("echo once-한");
  await key(page, "Send").click();
  await cdp.detach();
  await expect(terminal).toContainText("once-한", { timeout: 15_000 });
  await expect(field(page)).toHaveValue("");
  expect(await value(page)).not.toContain("once-한한");
});

test("pasting into the fixed field sends the pasted line when Enter is pressed", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.evaluate(() => navigator.clipboard.writeText("echo pasted-$((6*7))"));
  await field(page).click();
  await pressWithCommand(page, `${await commandModifier(page)}+v`, "paste");
  await expect(field(page)).toHaveValue("echo pasted-$((6*7))");
  expect(await value(page)).not.toContain("pasted-42");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("pasted-42", { timeout: 15_000 });
  await expect(field(page)).toHaveValue("");
  await expect(field(page)).toBeFocused();
  await expect(keysBar(page)).toBeVisible();
});
