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

  // What the report is about: Alt+Left and Alt+Right were bound to pane.go, so with a neighbour that way Doriterm moved
  // focus instead of sending anything (#1302, #1942). Alt+Up was bound to agent.prev, which is why it is the easy half.
  //
  // Since #1600 a pane key at a split edge both nudges the pane AND hands the key to the program, so "the sequence
  // arrived" alone no longer distinguishes the two behaviours: it passes with the binding restored. Focus is what
  // separates them - a pane move takes focus off this terminal, and nothing else in these chords may.
  const focused = first.getByRole("textbox").first();

  // Toward the neighbour: the old pane.go:right moved focus to the other pane.
  await page.keyboard.press("Alt+ArrowRight");
  await expect(first, "the program receives Alt+Right").toContainText("[1;3C", { timeout: 20_000 });
  await expect(focused, "Alt+Right left focus on this terminal").toBeFocused();
  await expect(panes, "Alt+Right opened or closed no pane").toHaveCount(2);

  // The easy half: Alt+Up was agent.prev, not a pane key, so the sequence alone catches its regression.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(first, "the program receives Alt+Up").toContainText("[1;3A", { timeout: 20_000 });
  await expect(focused, "Alt+Up left focus alone").toBeFocused();
  await expect(panes, "Alt+Up opened or closed no pane").toHaveCount(2);

  // Alt+Left needs a pane with a neighbour on its LEFT, not the edge: #1600 hands a pane key to the program only when
  // there is no pane that way, so at the edge the old pane.go:left binding and no binding at all look identical. The
  // second pane is the one where the old binding swallowed the key.
  const second = panes.nth(1);
  await second.getByRole("textbox").first().focus();
  await page.keyboard.type("cat -v");
  await page.keyboard.press("Enter");
  await expect(second).toContainText("cat -v", { timeout: 20_000 });

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(second, "the program receives Alt+Left").toContainText("[1;3D", { timeout: 20_000 });
  await expect(second.getByRole("textbox").first(), "Alt+Left did not walk focus into the left pane").toBeFocused();
  await expect(panes, "Alt+Left opened or closed no pane").toHaveCount(2);
});
