// Every piece of text in the two import dialogs meets WCAG AA contrast against what is painted behind it, in both
// themes (#473): 4.5:1, or 3:1 for large text.
import { SCREENS, STARTS } from "./layout-screens.ts";
import { expect, test } from "./fixtures.ts";
import { clearLayoutHost, clearLayouts } from "./layout-doc.ts";

const DIALOGS = new Set(["dialog-import-config", "dialog-import-keybinds"]);

/** Each text in the open dialog, with its contrast ratio and whether it counts as large text. */
function dialogContrasts(): { readonly text: string; readonly ratio: number; readonly large: boolean }[] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  if (paint === null) throw new Error("no 2d canvas");
  // Any CSS colour (rgb, oklch, color-mix ...) to 8-bit sRGB and alpha, as the browser paints it.
  const rgba = (css: string): [number, number, number, number] => {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = css;
    paint.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = paint.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
  const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
  ];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
  const luminance = ([r, g, b]: [number, number, number]): number => {
    const [lr, lg, lb] = [r, g, b].map((value) => {
      const c = value / 255;
      return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0);
  };
  // The colour painted behind `el`: its own and its ancestors' backgrounds, composited from the page up.
  const behind = (el: Element): [number, number, number] => {
    const layers: [number, number, number, number][] = [];
    for (let at: Element | null = el; at !== null; at = at.parentElement) {
      const layer = rgba(getComputedStyle(at).backgroundColor);
      if (layer[3] > 0) layers.push(layer);
      if (layer[3] === 1) break;
    }
    return layers.reduceRight<[number, number, number]>((under, top) => over(top, under), [255, 255, 255]);
  };
  // The import dialog, over Settings' own dialog where Settings is one.
  const dialog = document.querySelector('[role="dialog"]:not([data-settings-dialog])');
  if (dialog === null) throw new Error("no dialog is open");
  const found: { text: string; ratio: number; large: boolean }[] = [];
  const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? "";
    const el = node.parentElement;
    if (text === "" || el === null || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      continue;
    const style = getComputedStyle(el);
    const ground = behind(el);
    const ink = over(rgba(style.color), ground);
    const [hi, lo] = [luminance(ink), luminance(ground)].toSorted((a, b) => b - a);
    const size = Number.parseFloat(style.fontSize);
    const bold = Number.parseInt(style.fontWeight, 10) >= 700;
    found.push({ text, ratio: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05), large: size >= 24 || (bold && size >= 18.66) });
  }
  return found;
}

test.use({ serviceWorkers: "block" });

for (const theme of ["day", "night"] as const) {
  for (const screen of SCREENS.filter(({ name }) => DIALOGS.has(name))) {
    test(`${screen.name} in ${theme}: every text meets WCAG AA contrast`, async ({ browser }) => {
      clearLayouts();
      clearLayoutHost();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        colorScheme: theme === "day" ? "light" : "dark",
      });
      const stored = STARTS[screen.start];
      await context.addInitScript(
        ([chosen, value]) => {
          localStorage.setItem("doriface.appearance", JSON.stringify({ theme: chosen, custom: [] }));
          if (value === null) localStorage.removeItem("doriface.connection");
          else localStorage.setItem("doriface.connection", value);
        },
        [theme, stored === null ? null : JSON.stringify(stored)] as const,
      );
      const page = await context.newPage();
      await screen.open(page, false);
      await page.evaluate(() => document.fonts.ready);
      const contrasts = await page.evaluate(dialogContrasts);
      await context.close();
      expect(contrasts.length).toBeGreaterThan(0);
      const below = contrasts
        .filter(({ ratio, large }) => ratio < (large ? 3 : 4.5))
        .map(({ text, ratio }) => `"${text}" ${ratio.toFixed(2)}:1`);
      expect(below).toEqual([]);
    });
  }
}
