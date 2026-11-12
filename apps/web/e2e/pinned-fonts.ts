import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * The e2e suite draws with its own faces (#862): the UI in Inter and Hangul in Noto Sans KR, both OFL and both cut to
 * what the suite draws (fonts/make-pinned-fonts.py). They are injected at document start, before any of the app's
 * scripts, because a face added after the app measured its cell grid changes the boxes a later assertion reads, and
 * the stylesheet is a :root:root rule so the app's own tokens.css cannot win by arriving later.
 *
 * Fonts shipped with the app stay first for the terminal's own symbols; the platform's Hangul names stay after the pin
 * so a syllable the subset lacks still falls back to a Hangul face. terminal-hangul.e2e.ts opts out (pinnedFonts: false)
 * because it asserts on the product stack in tokens.css. These are test-only families and test-only tokens: nothing
 * here ships in the app, and no product font changes.
 */
const UI = readFileSync(new URL("./fonts/pinned-ui.woff2", import.meta.url)).toString("base64");
const HANGUL = readFileSync(new URL("./fonts/pinned-hangul.woff2", import.meta.url)).toString("base64");

const UI_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

const styles = (name: string): string =>
  readFileSync(new URL(`../../../packages/ui/src/styles/${name}`, import.meta.url), "utf8");

/** The families of a `font-family` value, in the order the browser tries them, each as written (quoted or not). */
function families(value: string): string[] {
  return value
    .split(",")
    .map((family) => family.trim())
    .filter((family) => family !== "");
}

/**
 * The terminal stack the suite draws with: the shipped `--font-term` (tokens.css), read rather than copied so it cannot
 * drift from what the app draws (#2034), with the pinned Hangul face added after the last face the app bundles
 * (terminal-fonts.css). The bundled faces keep the terminal's own symbols, Powerline included (#1403); the platform's
 * Hangul names after the pin still catch a syllable the subset lacks.
 */
export function pinnedTermStack(tokens: string, bundled: string): string {
  const shipped = families(/--font-term:\s*([^;]+);/s.exec(tokens)?.[1] ?? "");
  if (shipped.length === 0) throw new Error("tokens.css declares no --font-term");
  const faces = new Set([...bundled.matchAll(/font-family:\s*"([^"]+)"/g)].map((match) => `"${match[1]}"`));
  const last = shipped.findLastIndex((family) => faces.has(family));
  if (last < 0) throw new Error("--font-term names none of the faces terminal-fonts.css bundles");
  return [...shipped.slice(0, last + 1), '"E2E Pinned Hangul"', ...shipped.slice(last + 1)].join(", ");
}

const TERM = pinnedTermStack(styles("tokens.css"), styles("terminal-fonts.css"));

export const PINNED_CSS = [
  '@font-face { font-family: "E2E UI"; font-style: normal; font-weight: 400; font-display: block;',
  `  src: url(data:font/woff2;base64,${UI}) format("woff2"); }`,
  '@font-face { font-family: "E2E Pinned Hangul"; font-style: normal; font-weight: 400; font-display: block;',
  `  src: url(data:font/woff2;base64,${HANGUL}) format("woff2"); }`,
  ":root:root {",
  `  --font-ui: "E2E UI", "E2E Pinned Hangul", ${UI_FALLBACK};`,
  `  --font-term: ${TERM};`,
  "}",
].join("\n");

/**
 * Puts the pinned stylesheet into every page of the context before the app runs. It is a context script, not a page
 * script: a spec can open a second page for a reference (terminal-wide-font-load.e2e.ts does), and a page without the
 * pin would measure the platform's faces against the pinned one's. It does not fulfil documents: a document Playwright
 * serves has no local address, and Chromium then refuses the page's dial to the loopback e2e host.
 */
export async function pinFonts(page: Page): Promise<void> {
  await page.context().addInitScript((css: string) => {
    const style = document.createElement("style");
    style.id = "e2e-pinned-fonts";
    style.textContent = css;
    const install = (): boolean => {
      const root = document.documentElement;
      if (root === null || document.getElementById("e2e-pinned-fonts") !== null) return root !== null;
      root.insertBefore(style, root.firstChild);
      return true;
    };
    if (install()) return;
    // `addInitScript` runs before the parser has created <html>; the first mutation is that element, and the observer's
    // microtask runs before the parser goes on to the <head> or any script in it.
    const observer = new MutationObserver(() => {
      if (install()) observer.disconnect();
    });
    observer.observe(document, { childList: true });
  }, PINNED_CSS);
}
