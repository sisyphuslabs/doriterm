import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

/**
 * The bug is on Windows and Linux, where Alt+arrows were bound to Doriterm's own actions, so the platform is pinned the
 * way split-resize.e2e.ts pins it: a macOS run would otherwise exercise the mac keymap, where Alt+Up was never an app
 * action, and pass without touching the regression.
 */
async function setPlatform(page: Page, platform: "mac" | "other"): Promise<void> {
  await page.addInitScript(
    (value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }),
    platform === "mac" ? "MacIntel" : "Linux x86_64",
  );
}

// A program's Alt+Up (ESC [ 1 ; 3 A) is how agent question UIs take "previous answer", and how an editor takes a word
// move. Doriterm may bind a chord to its own action, but Alt+arrows belong to the program (#1302).
test("Alt+Up reaches the program on a lone pane", async ({ page }) => {
  await setPlatform(page, "other");
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  // cat -v prints what it receives, so the escape shows up as text the assertion can read.
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("cat -v", { timeout: 20_000 });

  await page.keyboard.press("Alt+ArrowUp");
  await expect(terminal, "the program receives Alt+Up's sequence").toContainText("[1;3A", { timeout: 20_000 });
});

test("Alt+Up reaches the program at the top edge of a split, and the pane does not move", async ({ page }) => {
  await setPlatform(page, "other");
  await page.goto("/");
  const first = await openNewTerminal(page);
  // Ctrl+Shift+O splits on this platform (defaults.ts, the Linux and Windows set).
  await page.keyboard.press("Control+Shift+O");
  const panes = page.locator("[role=tabpanel]:not([hidden]) section[data-split]");
  await expect(panes, "the tab holds a split").toHaveCount(2, { timeout: 20_000 });
  await first.getByRole("textbox").focus();
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await expect(first).toContainText("cat -v", { timeout: 20_000 });

  // The chords that actually swallowed a key here were Alt+Left and Alt+Right: they were bound to pane.go, so with a
  // neighbour that way Doriterm moved focus instead of sending anything (#1302, #1942). Alt+Up was bound to agent.prev,
  // which is why it is the easier half of the proof.
  for (const [key, sequence] of [
    ["Alt+ArrowRight", "[1;3C"],
    ["Alt+ArrowUp", "[1;3A"],
    ["Alt+ArrowLeft", "[1;3D"],
  ] as const) {
    await page.keyboard.press(key);
    await expect(first, `the program receives ${key} rather than a pane move`).toContainText(sequence, {
      timeout: 20_000,
    });
    await expect(panes, `${key} opened or closed no pane`).toHaveCount(2);
  }
});
