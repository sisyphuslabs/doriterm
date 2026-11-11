import type { CDPSession, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

/**
 * What agents and prompts draw past Latin text: box drawing, blocks, a braille spinner, Claude Code's marks, arrows
 * and status marks, powerline separators and Nerd Font icons. A device with no face for one of them shows tofu (iOS
 * has none for the icons, #949), so each must come from a face the app ships.
 */
const PROBES = {
  "box drawing": "─│┌┐└┘├┤┬┴┼═║╭╮╯╰",
  blocks: "█▀▄▌▐░▒▓",
  braille: "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  "agent marks": "⏺⎿✻✳✢",
  arrows: "→←⇒↵⧉",
  status: "●◆✓✔✘★⚡⚠ⓘ",
  "powerline E0A0": "\ue0a0",
  "powerline E0B0": "x\ue0b0",
  "powerline E0B1": "x\ue0b1",
  "powerline E0B2": "x\ue0b2",
  "powerline E0B3": "x\ue0b3",
  "powerline E0B4": "x\ue0b4",
  "powerline E0B5": "x\ue0b5",
  "powerline E0B6": "x\ue0b6",
  "powerline E0B7": "x\ue0b7",
  "nerd icons": "\uf015\uf07b\ue718\uf113",
} as const;

/** `text` as printf's octal escapes, so the shell prints exactly these bytes. */
function octal(text: string): string {
  return [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");
}

/** The faces that drew the row holding `text`, as Chromium reports them, and whether each is one the page loaded. */
async function facesOf(
  page: Page,
  cdp: CDPSession,
  text: string,
): Promise<readonly { name: string; bundled: boolean }[]> {
  await page.evaluate((probe) => {
    const row = [...document.querySelectorAll(".term-row")].find((node) => node.textContent?.includes(probe));
    row?.setAttribute("data-probe", "");
  }, text);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-probe] span" });
    const reports = await Promise.all(nodeIds.map((nodeId) => cdp.send("CSS.getPlatformFontsForNode", { nodeId })));
    return reports.flatMap(({ fonts }) => fonts.map((font) => ({ name: font.familyName, bundled: font.isCustomFont })));
  } finally {
    await page.evaluate(() => document.querySelector("[data-probe]")?.removeAttribute("data-probe"));
  }
}

/**
 * Every bundled face is declared per unicode-range with font-display: swap, so the browser fetches a face only once a
 * glyph asks for it, and until then draws the row with a system fallback. Waiting for exactly those loads, not for a
 * time, is what makes the read below hold under any load (#1991): `document.fonts.load` resolves once the faces that
 * cover the text at the rows' font have loaded, then two frames let the rows be laid out again in them.
 */
async function fontsLoadedFor(page: Page, texts: readonly string[]): Promise<void> {
  await page.evaluate(async (probes) => {
    const row = document.querySelector('[data-focused="true"] .term-row');
    if (row === null) throw new Error("no terminal row");
    const style = getComputedStyle(row);
    await Promise.all(probes.map((probe) => document.fonts.load(`${style.fontSize} ${style.fontFamily}`, probe)));
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, texts);
}

test("symbols, spinners and icons in the terminal are drawn by faces the app ships, on any device (#949)", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$");
  await terminal.getByRole("textbox").focus();
  const lines = Object.values(PROBES);
  // One input, as a paste: typed key by key, this 851-character command is a round trip a key to the terminal, which
  // under whole-suite load took the whole test budget before a row was read (#1991).
  await page.keyboard.insertText(`printf '\\033[2J\\033[H${lines.map(octal).join("\\n")}\\n'`);
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        (probes) => {
          const rows = [...document.querySelectorAll('[data-focused="true"] .term-row')].map((row) => row.textContent);
          return probes.filter((probe) => !rows.some((text) => text?.includes(probe)));
        },
        [...lines],
      ),
    )
    .toEqual([]);
  await fontsLoadedFor(page, lines);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    for (const [name, text] of Object.entries(PROBES)) {
      // oxlint-disable-next-line no-await-in-loop -- one row at a time: each marks its row, which the next unmarks
      const faces = await facesOf(page, cdp, text);
      expect(
        faces.filter((face) => !face.bundled).map((face) => face.name),
        `${name} (${text}) drawn by a face the app does not ship`,
      ).toEqual([]);
      console.log(`${name}: ${[...new Set(faces.map((face) => face.name))].join(", ")}`);
    }
  } finally {
    await cdp.detach();
  }
});
