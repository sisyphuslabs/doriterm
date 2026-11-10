// #1372: a phone's soft keyboard going away re-fits the terminal to more rows. A plain shell at the bottom (one that does
// not redraw for the new size, unlike an agent's TUI) must still be at the bottom afterwards, its last line on screen.
import type { Locator, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { key, openPhoneTerminal, PHONE, showKeyboard } from "./phone-key-bar.ts";

test.use({ ...PHONE, serviceWorkers: "block" });

const LINES = 300;
const KEYBOARD = 336;

const fromBottom = (terminal: Locator): Promise<number> =>
  terminal.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);

const rows = (terminal: Locator): Promise<number> => terminal.locator(".term-row:not(.term-scrollback-row)").count();

/** The last numbered line inside the scroll box's visible height. */
const lastInView = (terminal: Locator): Promise<string> =>
  terminal.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const seen = [...element.querySelectorAll(".term-row")].filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && /line \d{5}/.test(row.textContent ?? "");
    });
    return seen.at(-1)?.textContent?.trim().slice(0, 10) ?? "";
  });

async function fillHistory(terminal: Locator): Promise<string> {
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  hcOn("host", ["send", address, `seq -f 'line %05g' 1 ${LINES}`]);
  await expect(terminal).toContainText(`line ${String(LINES).padStart(5, "0")}`, { timeout: 20_000 });
  await expect.poll(() => fromBottom(terminal)).toBeLessThan(5);
  return address;
}

async function expectBottom(terminal: Locator, what: string): Promise<void> {
  await expect.poll(() => fromBottom(terminal), what).toBeLessThan(5);
  await expect.poll(() => lastInView(terminal), `${what}: the last output line is on screen`).toBe("line 00300");
}

const shapes: {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly close: (page: Page) => Promise<void>;
}[] = [
  {
    name: "overlay",
    open: async (page) => {
      await key(page, "Show keyboard").click();
    },
    close: (page) => showKeyboard(page, 0),
  },
  {
    name: "resize",
    open: async (page) => {
      await key(page, "Show keyboard").click();
      await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
    },
    close: (page) => page.setViewportSize({ width: 390, height: 844 }),
  },
];

for (const shape of shapes) {
  test(`a shell at the bottom stays at the bottom when the ${shape.name} keyboard is dismissed`, async ({ page }) => {
    const terminal = await openPhoneTerminal(page, 390, shape.name === "overlay" ? "overlay" : "resize");
    if (shape.name === "resize") await page.setViewportSize({ width: 390, height: 844 - KEYBOARD });
    const address = await fillHistory(terminal);
    const round = async (n: number): Promise<void> => {
      const keyboardUp = await rows(terminal);
      await shape.close(page);
      await expect.poll(() => rows(terminal), "dismissing the keyboard gives rows back").toBeGreaterThan(keyboardUp);
      await expectBottom(terminal, `round ${n}: at the bottom once the keyboard is gone`);
      const tall = await rows(terminal);
      await shape.open(page);
      await expect.poll(() => rows(terminal), "the keyboard takes rows").toBeLessThan(tall);
      await expectBottom(terminal, `round ${n}: at the bottom with the keyboard up`);
    };
    try {
      await round(1);
      await round(2);
    } finally {
      endAgent("host", address);
    }
  });
}
