import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * The e2e suite draws with its own faces (#862): the UI in Inter and Hangul in Noto Sans KR, both OFL and both cut to
 * what the suite draws (fonts/make-pinned-fonts.py). They are injected at document start, before any of the app's
 * scripts, because a face added after the app measured its cell grid changes the boxes a later assertion reads, and
 * the stylesheet is a :root:root rule so the app's own tokens.css cannot win by arriving later.
 *
 * Fonts shipped with the app stay first for the terminal's own symbols; the platform's Hangul names stay after the pin
 * so terminal-hangul.e2e.ts still reads the product stack it asserts on. These are test-only families and test-only
 * tokens: nothing here ships in the app, and no product font changes.
 */
const UI = readFileSync(new URL("./fonts/pinned-ui.woff2", import.meta.url)).toString("base64");
const HANGUL = readFileSync(new URL("./fonts/pinned-hangul.woff2", import.meta.url)).toString("base64");

const UI_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

const TERM_FALLBACK =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Apple SD Gothic Neo", "Noto Sans Mono CJK KR", "Noto Sans CJK KR", "Noto Sans KR", "Malgun Gothic", "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", monospace';

const CSS = [
  '@font-face { font-family: "E2E UI"; font-style: normal; font-weight: 400; font-display: block;',
  `  src: url(data:font/woff2;base64,${UI}) format("woff2"); }`,
  '@font-face { font-family: "E2E Hangul"; font-style: normal; font-weight: 400; font-display: block;',
  `  src: url(data:font/woff2;base64,${HANGUL}) format("woff2"); }`,
  ":root:root {",
  `  --font-ui: "E2E UI", "E2E Hangul", ${UI_FALLBACK};`,
  `  --font-term: "JetBrains Mono Variable", "JetBrains Mono", "Symbols Nerd Font Mono", "Doriterm Noto Symbols 2", "Doriterm Noto Symbols", "Doriterm Noto Math", "E2E Hangul", ${TERM_FALLBACK};`,
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
  }, CSS);
}
