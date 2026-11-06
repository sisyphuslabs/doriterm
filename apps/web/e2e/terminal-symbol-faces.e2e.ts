import type { Page } from "@playwright/test";
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
  powerline: "\ue0a0\ue0b0\ue0b2",
  "nerd icons": "\uf015\uf07b\ue718\uf113",
} as const;

/** `text` as printf's octal escapes, so the shell prints exactly these bytes. */
function octal(text: string): string {
  return [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");
}

/** The faces that drew the row holding `text`, as Chromium reports them, and whether each is one the page loaded. */
async function facesOf(page: Page, text: string): Promise<readonly { name: string; bundled: boolean }[]> {
  await page.evaluate((probe) => {
    const row = [...document.querySelectorAll(".term-row")].find((node) => node.textContent?.includes(probe));
    row?.setAttribute("data-probe", "");
  }, text);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-probe] span" });
    const reports = await Promise.all(nodeIds.map((nodeId) => cdp.send("CSS.getPlatformFontsForNode", { nodeId })));
    return reports.flatMap(({ fonts }) => fonts.map((font) => ({ name: font.familyName, bundled: font.isCustomFont })));
  } finally {
    await page.evaluate(() => document.querySelector("[data-probe]")?.removeAttribute("data-probe"));
    await cdp.detach();
  }
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
  await page.keyboard.type(`printf '\\033[2J\\033[H${lines.map(octal).join("\\n")}\\n'`);
  await page.keyboard.press("Enter");
  for (const [name, text] of Object.entries(PROBES)) {
    // oxlint-disable-next-line no-await-in-loop -- one row at a time, each read once its fonts have loaded
    await expect
      .poll(async () => (await facesOf(page, text)).filter((face) => !face.bundled).map((face) => face.name), {
        message: `${name} (${text}) drawn by a face the app does not ship`,
        timeout: 10_000,
      })
      .toEqual([]);
  }
});
