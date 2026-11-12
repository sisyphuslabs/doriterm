// On Linux and Windows an Alt chord is the program's (#1302, #1942) unless it is one of herdr-app's own families that
// `ALT_KEPT` lists: Alt+1-9 there switch the space even from a focused terminal (#1925). This pins both halves at once.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { paneOf, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");

/** Two spaces of one plain shell each, their tabs named alt-1 and alt-2; their addresses in order. */
function twoSpaces(): string[] {
  const root = mkdtempSync(join(tmpdir(), "alt-keys-program-"));
  const spaces = [1, 2].map((place) => {
    const folder = mkdtempSync(join(root, `s${place}-`));
    const out = hcOn("host", ["run", "--bg", "--name", `alt-${place}`, "--cwd", folder, "--", "env", "PS1=$ ", "sh"]);
    return { place, folder, terminal: String((JSON.parse(out) as { address: string }).address) };
  });
  seedSpaces(
    spaces.map(({ place, folder, terminal }) => ({
      id: `spc-alt-${place}`,
      name: `s${place}`,
      folder,
      tabs: [{ id: `tb-alt-${place}`, name: `alt-${place}`, terminal }],
    })),
  );
  return spaces.map(({ terminal }) => terminal);
}

test("Alt+. and Alt+0 reach the program while Alt+2 switches the space (Linux)", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64" });
  });
  const [first = "", second = ""] = twoSpaces();
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/alt-1$/], { timeout: 20_000 });
  const output = paneOf(page, first).locator("[data-terminal]");
  const focus = async (address: string): Promise<void> => {
    await paneOf(page, address).getByRole("textbox").focus();
    await expect(paneOf(page, address).getByRole("textbox")).toBeFocused();
  };

  await focus(first);
  // cat -v prints every byte it reads, ESC as ^[, once a line ends.
  await page.keyboard.type("printf 'CAT%s\\n' READY; cat -v\r");
  await expect(output).toContainText("CATREADY", { timeout: 20_000 });

  await page.keyboard.press("Alt+Period");
  await page.keyboard.press("Alt+Digit0");
  await page.keyboard.press("Alt+Digit2");
  await expect(tabBar(page), "Alt+2 is herdr-app's space chord, kept on purpose").toHaveText([/alt-2$/]);
  await focus(second);
  await page.keyboard.press("Alt+Digit1");
  await expect(tabBar(page)).toHaveText([/alt-1$/]);
  await focus(first);
  await page.keyboard.type("END\r");

  await expect
    .poll(async () => {
      const text = (await output.textContent()) ?? "";
      return text.slice(text.lastIndexOf("CATREADY") + "CATREADY".length).replace(/\s+/g, "");
    })
    // The echoed line, then cat's copy of it: Alt+. and Alt+0 as ESC . and ESC 0, and no byte of either space chord.
    .toMatch(/^\^\[\.\^\[0END\^\[\.\^\[0END/);
});
