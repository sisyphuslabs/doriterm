// Korean wraps between words, never inside one, and a row's icon sits on its text's first line: Settings >
// Connections at 390 with the layout host's long Korean name (#480).
import { STARTS } from "./layout-screens.ts";
import { LAYOUT_CORE } from "./layout-seed.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

/** Hangul syllables and jamo: two of them side by side are one word, wherever the line falls. */
const HANGUL = "[\\u1100-\\u11ff\\u3130-\\u318f\\uac00-\\ud7af]";

interface Wrap {
  readonly lines: string[];
  /** Where in the text each line after the first starts. */
  readonly starts: number[];
  readonly iconOffsetPx: number;
}

function measure(root: HTMLElement, text: string): Wrap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | undefined;
  for (let next = walker.nextNode(); next !== null; next = walker.nextNode()) {
    if (next.textContent === text) node = next as Text;
  }
  if (node === undefined) throw new Error(`no text node holds ${text}`);
  const starts: number[] = [];
  let top: number | undefined;
  let lineTop = 0;
  let lineBottom = 0;
  for (let i = 0; i < text.length; i++) {
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && text[i] === " ") continue;
    if (top === undefined) {
      lineTop = box.top;
      lineBottom = box.bottom;
      top = box.top;
    } else if (box.top > top + box.height / 2) {
      starts.push(i);
      top = box.top;
    }
  }
  const lines = [0, ...starts].map((start, index) => text.slice(start, starts[index] ?? text.length));
  const icon = node.parentElement?.parentElement?.querySelector("svg");
  if (icon === null || icon === undefined) throw new Error("no icon beside the text");
  const iconBox = icon.getBoundingClientRect();
  const iconOffsetPx = Math.abs((iconBox.top + iconBox.bottom) / 2 - (lineTop + lineBottom) / 2);
  return { lines: lines.map((line) => line.trim()), starts, iconOffsetPx };
}

test("a long Korean host name wraps between words, and its icon sits on the first line (390)", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(
    (value) => localStorage.setItem("doriface.connection", value),
    JSON.stringify(STARTS.layout),
  );
  const page = await context.newPage();
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Connections" }).click();
  // The workspace stays mounted and hidden under Settings (router.tsx), and its own machine header and status bar name
  // the host as well: they are in the page at 390 but never visible, so the row holds the one name a reader sees (#836).
  const paired = page.locator("section").filter({ has: page.getByRole("heading", { name: "Paired devices" }) });
  const name = paired.getByText(LAYOUT_CORE);
  await expect(name).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(LAYOUT_CORE).filter({ visible: true })).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const wrap = await name.evaluate(measure, LAYOUT_CORE);
  expect(wrap.lines.length, `laid out on ${JSON.stringify(wrap.lines)}`).toBeGreaterThan(1);
  const hangul = new RegExp(`^${HANGUL}$`);
  for (const [index, start] of wrap.starts.entries()) {
    // A line that starts on Hangul with Hangul just before it in the text, no space between, split one word in two.
    const split = hangul.test(LAYOUT_CORE[start - 1] ?? "") && hangul.test(LAYOUT_CORE[start] ?? "");
    expect(split, `line ${index + 2} of ${JSON.stringify(wrap.lines)} starts inside a word`).toBe(false);
  }
  expect(wrap.iconOffsetPx, "the icon's centre is on the first line's").toBeLessThanOrEqual(1);
  await context.close();
});
