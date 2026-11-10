// Cmd+Shift+R (Ctrl+Shift+R off macOS) renames the tab in view (#702), beside herdr-app's F2, from a focused terminal.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { paneOf, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { chordOf, triggersFor } from "./platform-keys.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");

function oneTab(name: string): string {
  const folder = mkdtempSync(join(tmpdir(), "tab-rename-key-"));
  const out = hcOn("host", ["run", "--bg", "--name", `${name}-sh`, "--cwd", folder, "--", "env", "PS1=$ ", "sh"]);
  const terminal = String((JSON.parse(out) as { address: string }).address);
  seedSpaces([{ id: `spc-${name}`, name: `space-${name}`, folder, tabs: [{ id: `tb-${name}`, name, terminal }] }]);
  return terminal;
}

/** doriface's own rename chord (#702), the one besides F2 that each platform binds to tab.rename. */
const renameChord = (platform: "mac" | "other"): string =>
  chordOf(triggersFor(platform, "tab.rename").find((trigger) => trigger !== "f2") ?? "");

const PLATFORMS = [
  { platform: "MacIntel", chord: renameChord("mac") },
  { platform: "Linux x86_64", chord: renameChord("other") },
] as const;

for (const { platform, chord } of PLATFORMS) {
  test(`${chord} on ${platform} opens the tab's rename question from its terminal, and the page stays`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }),
      platform,
    );
    const name = platform === "MacIntel" ? "rename-mac" : "rename-other";
    const terminal = oneTab(name);
    await page.goto("/");
    await expect(tabBar(page)).toHaveText([new RegExp(name)], { timeout: 20_000 });
    await paneOf(page, terminal).getByRole("textbox").focus();
    await page.evaluate(() => Reflect.set(window, "sameDocument", true));

    await page.keyboard.press(chord);
    const question = page.getByRole("dialog", { name: `Rename ${name}` });
    await expect(question.getByRole("textbox", { name: "Name" })).toHaveValue(name);
    expect(await page.evaluate(() => Reflect.get(window, "sameDocument"))).toBe(true);

    await question.getByRole("textbox", { name: "Name" }).fill(`${name}-renamed`);
    await page.keyboard.press("Enter");
    await expect(question).toHaveCount(0);
    await expect(tabBar(page)).toHaveText([new RegExp(`${name}-renamed`)]);
  });
}
