// How a control's ink composites onto its fill, as the browser paints it, for the disabled-contrast specs (#1031, #1034).
import type { Locator, Page } from "@playwright/test";
import { contrast as tokenContrast, hex as tokenHex, luminance as tokenLuminance, parseRgb } from "@doriface/ui/theme";

export type Rgb = [number, number, number];

export interface Ask {
  /** Paints the button's parent with this theme surface (`--<surface>`) first, as if the button sat on it. */
  readonly surface?: string;
  /** The ink is the button's first svg (an icon or the loading spinner) instead of its label text. */
  readonly svg?: boolean;
  /** An ink to measure this one against, e.g. the same button's while it was enabled. */
  readonly enabled?: Rgb;
  /**
   * The ink is this part instead of the label: a descendant (or the element itself when the selector is ""), its text
   * colour or its own background, the latter measured against what it sits on, e.g. a Switch's thumb on its track.
   */
  readonly part?: { readonly selector: string; readonly paint: "color" | "background" };
}

export interface Painted {
  readonly label: string;
  readonly ratio: number;
  readonly fromEnabled: number;
  /** The ink against `Ask.enabled`; 1 when none was given. */
  readonly step: number;
  readonly ink: Rgb;
}

/**
 * Composites the button's ink and its fill the way the browser paints them: each element's background under its
 * descendants, then its opacity on the whole group, up to the page. A fade on the whole button fades both together.
 */
export function painted(button: Element, ask: Ask): Painted {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  if (paint === null) throw new Error("no 2d canvas");
  const premultiplied = (css: string): [number, number, number, number] => {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = css;
    paint.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = paint.getImageData(0, 0, 1, 1).data;
    const alpha = a / 255;
    return [(r / 255) * alpha, (g / 255) * alpha, (b / 255) * alpha, alpha];
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
  const over = (top: number[], under: number[]): number[] =>
    top.map((value, index) => value + (under[index] ?? 0) * (1 - (top[3] ?? 0)));
  /** `inner` (what sits inside `from`) composited through `from` and every ancestor, onto a white page. */
  const through = (from: Element, inner: number[]): Rgb => {
    let layer = inner;
    for (let at: Element | null = from; at !== null; at = at.parentElement) {
      const style = getComputedStyle(at);
      layer = over(layer, premultiplied(style.backgroundColor));
      const opacity = Number.parseFloat(style.opacity);
      layer = layer.map((value) => value * opacity);
    }
    const [r = 0, g = 0, b = 0] = over(layer, [1, 1, 1, 1]);
    return [r, g, b];
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const luminance = (rgb: Rgb): number => {
    const [lr = 0, lg = 0, lb = 0] = rgb.map((c) => (c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const contrast = (a: Rgb, b: Rgb): number => {
    const [hi = 0, lo = 0] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const hex = (rgb: Rgb): string =>
    `#${rgb
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;

  const parent = button.parentElement;
  if (!(parent instanceof HTMLElement)) throw new Error("the button has no parent");
  const before = parent.style.backgroundColor;
  if (ask.surface !== undefined) parent.style.backgroundColor = `var(--${ask.surface})`;
  try {
    let holder: Element | null | undefined;
    if (ask.part !== undefined) holder = ask.part.selector === "" ? button : button.querySelector(ask.part.selector);
    else if (ask.svg === true) holder = button.querySelector("svg");
    else {
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text !== null && (text.textContent ?? "").trim() === "") text = walker.nextNode();
      holder = text?.parentElement;
    }
    if (holder === null || holder === undefined) throw new Error("the control has no label, icon or part to measure");
    const background = ask.part?.paint === "background";
    const fill = through(background ? (holder.parentElement ?? holder) : holder, [0, 0, 0, 0]);
    const ink = background
      ? through(holder, [0, 0, 0, 0])
      : through(holder, premultiplied(getComputedStyle(holder).color));
    const enabled = through(
      parent,
      premultiplied(getComputedStyle(document.documentElement).getPropertyValue("--primary")),
    );
    return {
      label: `${hex(ink)} on ${hex(fill)}${ask.surface === undefined ? "" : ` (--${ask.surface})`}${ask.enabled === undefined ? "" : `, enabled ${hex(ask.enabled)}`}`,
      ratio: contrast(ink, fill),
      fromEnabled: contrast(fill, enabled),
      step: ask.enabled === undefined ? 1 : contrast(ink, ask.enabled),
      ink,
    };
  } finally {
    parent.style.backgroundColor = before;
  }
}

/**
 * Measures once every transition that paints the button has settled, with the pointer off it: its own, and its
 * ancestors', such as a menu popup's enter fade (#1362). Base UI starts that fade a frame after the popup mounts, so each
 * pass waits two frames before it looks; a finite animation on the button or an ancestor sends it round again.
 */
export async function measure(page: Page, button: Locator, ask: Ask = {}): Promise<Painted> {
  await page.mouse.move(0, 0);
  await button.evaluate(async (element) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function as source, so its helpers live inside it
    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- each pass looks only after the frames that start a pending fade
      await frame();
      // oxlint-disable-next-line no-await-in-loop -- as above
      await frame();
      const settling = document.getAnimations().filter((animation) => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect) || effect.target === null) return false;
        // A finished animation that holds its last frame (`forwards` fill) is settled: waiting on it would never end.
        if (animation.playState === "finished") return false;
        return effect.target.contains(element) && effect.getComputedTiming().endTime !== Infinity;
      });
      if (settling.length === 0) return;
      // A cancelled transition rejects `finished`; the next pass looks again either way.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await Promise.allSettled(settling.map((animation) => animation.finished));
    }
  });
  return button.evaluate(painted, ask);
}

/** Every surface a filled Button sits on: the page, a card or panel, the sidebar, a raised control, a dialog or menu. */
export const SURFACES = ["background", "surface", "chrome", "raised", "popover"] as const;

/** Whether pixel `a` is lighter than `b`, both 0xrrggbb. */
const lighter = (a: number, b: number): boolean => tokenLuminance(a) > tokenLuminance(b);

/**
 * A control's glyph as the screen shows it: an element screenshot read pixel by pixel, the fill being its most common
 * colour and the ink its darkest pixel on a light theme or its lightest on a dark one. A thin stroke on a half pixel is
 * antialiased lighter than its colour, which the computed style cannot see (#2513, visual QA).
 */
export async function screenGlyph(
  page: Page,
  control: Locator,
  dark: boolean,
): Promise<{ label: string; ratio: number }> {
  await page.mouse.move(0, 0);
  const shot = (await control.screenshot()).toString("base64");
  const pixels = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const paint = canvas.getContext("2d", { willReadFrequently: true });
    if (paint === null) throw new Error("no 2d canvas");
    paint.drawImage(image, 0, 0);
    const { data: rgba } = paint.getImageData(0, 0, image.width, image.height);
    const out: number[] = [];
    for (let at = 0; at < rgba.length; at += 4) {
      out.push(((rgba[at] ?? 0) << 16) | ((rgba[at + 1] ?? 0) << 8) | (rgba[at + 2] ?? 0));
    }
    return out;
  }, shot);
  const counts = new Map<number, number>();
  for (const pixel of pixels) counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
  const [fill = 0] = [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0] ?? [];
  const ink = pixels.reduce((best, pixel) => ((dark ? lighter(pixel, best) : lighter(best, pixel)) ? pixel : best));
  return { label: `${tokenHex(ink)} on ${tokenHex(fill)} as painted`, ratio: tokenContrast(ink, fill) };
}

/** How far the tokens dim a disabled glyph from the enabled one: --muted-foreground against --disabled-glyph, as themed. */
export async function tokenStep(page: Page): Promise<number> {
  const [muted, disabled] = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return [style.getPropertyValue("--muted-foreground").trim(), style.getPropertyValue("--disabled-glyph").trim()];
  });
  const from = parseRgb(muted);
  const to = parseRgb(disabled);
  if (from === undefined || to === undefined) throw new Error(`unreadable tokens: ${muted} / ${disabled}`);
  return tokenContrast(from, to);
}
