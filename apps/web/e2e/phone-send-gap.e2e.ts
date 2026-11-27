import type { Page } from "@playwright/test";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// No clipboard permissions here: WebKit refuses them, and this spec has to run there too (iOS is the phone it guards).
test.use({ serviceWorkers: "block", ...PHONE });

/** Where CAPTURE=1 writes the phone-width shots of the field and Send, one per state, theme and engine. */
const OUT = join(import.meta.dirname, "../../../docs/design/app");

const field = (page: Page) => page.getByLabel("Type into the terminal");

/**
 * The space between the focused field's focus outline, at its outer bottom edge, and the top of Send under it, in CSS px
 * (#1516). An outline drawn outside the field's box takes that much of the gap; one drawn inside it takes none.
 */
async function ringGap(page: Page): Promise<number> {
  const [outer, send] = await Promise.all([
    field(page).evaluate((element) => {
      const style = getComputedStyle(element);
      const outside =
        style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      return element.getBoundingClientRect().bottom + Math.max(0, outside);
    }),
    key(page, "Send").boundingBox(),
  ]);
  if (send === null) throw new Error("Send is not laid out");
  return send.y - outer;
}

/**
 * As the Herdr app's card, Send sits under the field at its end with the mic before it: the space between the field's
 * bottom and Send's top, the space between the mic and Send, and Send's size, in CSS px.
 */
async function measure(
  page: Page,
): Promise<{ gap: number; micGap: number; send: { width: number; height: number }; field: number }> {
  const [box, send, mic] = await Promise.all([
    field(page).boundingBox(),
    key(page, "Send").boundingBox(),
    page
      .getByRole("group", { name: "Input card", exact: true })
      .getByRole("button", { name: /^Dictat/ })
      .boundingBox(),
  ]);
  if (box === null || send === null || mic === null) throw new Error("the field, the mic or Send is not laid out");
  return {
    gap: send.y - (box.y + box.height),
    micGap: send.x - (mic.x + mic.width),
    send: { width: send.width, height: send.height },
    field: box.height,
  };
}

for (const theme of ["day", "night"] as const) {
  test(`Send keeps the phone chrome's 0.5rem gap from the field, idle and grown, in the ${theme} theme (#1506)`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: theme === "day" ? "light" : "dark" });
    await page.addInitScript((chosen) => {
      localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
    }, theme);
    const terminal = await openPhoneTerminal(page);
    await key(page, "Type in a field").click();
    await terminal.click();
    await expect(field(page)).toBeVisible();
    await expect.poll(async () => (await field(page).boundingBox())?.height).toBe(44);
    const idle = await measure(page);
    // 0.5rem: what the phone chrome leaves between two pressable controls (the round buttons' 3.5rem slot is a 3rem
    // button and this gap). Asserted as that exact number, so a tighter or a looser row, or a shrunk button, fails here.
    expect(idle.gap).toBe(8);
    expect(idle.micGap).toBe(8);
    expect(idle.send).toEqual({ width: 44, height: 44 });
    const shot = async (state: string): Promise<void> => {
      if (process.env["CAPTURE"] !== "1") return;
      await page.screenshot({
        path: join(OUT, `phone-send-gap-${state}-390-${theme}-${info.project.name}.png`),
      });
    };
    await shot("idle");

    await field(page).click();
    await expect(field(page)).toBeFocused();
    // Focused, the ring stays inside the field, so the visible gap to Send is still the chrome's 0.5rem (#1516).
    expect(await ringGap(page)).toBe(8);
    await shot("idle-focused");
    await page.keyboard.type("echo one two three four five six seven eight nine ten eleven twelve thirteen");
    await expect.poll(async () => (await field(page).boundingBox())?.height ?? 0).toBeGreaterThan(44);
    const grown = await measure(page);
    expect(grown.gap).toBe(8);
    expect(grown.micGap).toBe(8);
    expect(grown.send).toEqual({ width: 44, height: 44 });
    expect(await ringGap(page)).toBe(8);
    await shot("grown");
    info.annotations.push({
      type: "send-gap",
      description: JSON.stringify({ theme, idle, grown }),
    });
  });
}
