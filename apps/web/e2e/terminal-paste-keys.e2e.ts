import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { pagePlatform, pressWithCommand, triggersFor } from "./platform-keys.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });

// Every chord the platform binds to paste (#862): Ctrl+Shift+V and Shift+Insert off a Mac, Cmd+V on one.
test("each paste chord the platform binds pastes the clipboard into the terminal, not a key code (#510)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  const chords = triggersFor(await pagePlatform(page), "terminal.paste");
  await chords.reduce<Promise<void>>(async (previous, chord, index) => {
    await previous;
    await page.evaluate((at) => navigator.clipboard.writeText(`pasted-${at}-$((6*7))`), index);
    await page.keyboard.type("echo ");
    await pressWithCommand(page, chord, "paste");
    await page.keyboard.press("Enter");
    await expect(terminal, chord).toContainText(`pasted-${index}-42`, { timeout: 15_000 });
  }, Promise.resolve());
});
