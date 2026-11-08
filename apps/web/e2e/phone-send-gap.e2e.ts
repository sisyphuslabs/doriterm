import type { Page } from "@playwright/test";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// No clipboard permissions here: WebKit refuses them, and this spec has to run there too (iOS is the phone it guards).
test.use({ serviceWorkers: "block", ...PHONE });

/** Where CAPTURE=1 writes the phone-width shots of the field and Send, one per state, theme and engine. */
const OUT = join(import.meta.dirname, "../../../docs/design/app");

const field = (page: Page) => page.getByLabel("Type into the terminal");

/** The space between the field's right edge and Send's left edge, and both controls' sizes, in CSS px. */
async function measure(
  page: Page,
): Promise<{ gap: number; send: { width: number; height: number }; field: number }> {
  const [box, send] = await Promise.all([
    field(page).boundingBox(),
    key(page, "Send").boundingBox(),
  ]);
  if (box === null || send === null) throw new Error("the field or Send is not laid out");
  return {
    gap: send.x - (box.x + box.width),
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
    await terminal.click();
    await expect(field(page)).toBeVisible();
    await expect.poll(async () => (await field(page).boundingBox())?.height).toBe(44);
    const idle = await measure(page);
    // 0.5rem: what the phone chrome leaves between two pressable controls (the round buttons' 3.5rem slot is a 3rem
    // button and this gap). Asserted as that exact number, so a tighter or a looser row, or a shrunk button, fails here.
    expect(idle.gap).toBe(8);
    expect(idle.send).toEqual({ width: 44, height: 44 });
    const shot = async (state: string): Promise<void> => {
      if (process.env["CAPTURE"] !== "1") return;
      await page.screenshot({
        path: join(OUT, `phone-send-gap-${state}-390-${theme}-${info.project.name}.png`),
      });
    };
    await shot("idle");

    await field(page).click();
    await page.keyboard.type(
      "echo one two three four five six seven eight nine ten eleven twelve thirteen",
    );
    await expect
      .poll(async () => (await field(page).boundingBox())?.height ?? 0)
      .toBeGreaterThan(44);
    const grown = await measure(page);
    expect(grown.gap).toBe(8);
    expect(grown.send).toEqual({ width: 44, height: 44 });
    await shot("grown");
    info.annotations.push({
      type: "send-gap",
      description: JSON.stringify({ theme, idle, grown }),
    });
  });
}
