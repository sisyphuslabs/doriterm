// herdr-app's space number chords are global key bindings, matched before its terminal view sees the key, so they act
// from a focused terminal as anywhere else (#1922): Ctrl+1-9 on a Mac, Alt+1-9 elsewhere. Plain Ctrl+letter stays the
// program's, as herdr-app leaves it (its keys.rs: "plain ctrl+letter always stays with the program").
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { paneOf, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { shortcut } from "./platform-keys.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const PLACES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");

/** Nine spaces of one plain shell each, in sidebar order, their tabs named nine-1 to nine-9; their addresses in order. */
function nineSpaces(): string[] {
  const root = mkdtempSync(join(tmpdir(), "space-keys-terminal-"));
  const spaces = PLACES.map((place) => {
    const folder = mkdtempSync(join(root, `s${place}-`));
    const out = hcOn("host", ["run", "--bg", "--name", `nine-${place}`, "--cwd", folder, "--", "env", "PS1=$ ", "sh"]);
    return { place, folder, terminal: String((JSON.parse(out) as { address: string }).address) };
  });
  seedSpaces(
    spaces.map(({ place, folder, terminal }) => ({
      id: `spc-nine-${place}`,
      name: `s${place}`,
      folder,
      tabs: [{ id: `tb-nine-${place}`, name: `nine-${place}`, terminal }],
    })),
  );
  return spaces.map(({ terminal }) => terminal);
}

for (const platform of ["MacIntel", "Linux x86_64"]) {
  test(`with a terminal focused, every space number chord shows that space, as in herdr-app (${platform})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => value });
    }, platform);
    const shells = nineSpaces();
    await page.goto("/");
    await expect(tabBar(page)).toHaveText([/nine-1/], { timeout: 20_000 });

    const focusTerminal = async (place: number, how: "click" | "focus"): Promise<void> => {
      const pane = paneOf(page, shells[place - 1] ?? "");
      if (how === "click") await pane.locator("[data-terminal]").click();
      else await pane.getByRole("textbox").focus();
      await expect(pane.getByRole("textbox")).toBeFocused();
    };

    const order = [2, 3, 4, 5, 6, 7, 8, 9, 1];
    await order.reduce<Promise<number>>(async (previous, place, index) => {
      const shown = await previous;
      const chord = await shortcut(page, `space.select:${place}`);
      await test.step(`${chord} from the terminal shows space ${place}`, async () => {
        await focusTerminal(shown, index % 2 === 0 ? "click" : "focus");
        await page.keyboard.press(chord);
        await expect(tabBar(page)).toHaveText([new RegExp(`nine-${place}$`)]);
      });
      return place;
    }, Promise.resolve(1));

    await test.step("Ctrl+L, no herdr-app chord, reaches the program and the space stays", async () => {
      await focusTerminal(1, "focus");
      await page.evaluate(() => {
        const field = document.querySelector('[data-focused="true"] [data-terminal] textarea');
        Reflect.set(window, "letterSeen", null);
        field?.addEventListener("keydown", (event: Event) => {
          const press = event as KeyboardEvent;
          Reflect.set(window, "letterSeen", { ctrl: press.ctrlKey, key: press.key });
        });
      });
      await page.keyboard.press("Control+KeyL");
      expect(await page.evaluate(() => Reflect.get(window, "letterSeen"))).toEqual({ ctrl: true, key: "l" });
      await expect(tabBar(page)).toHaveText([/nine-1$/]);
    });

    await test.step("the program reads no byte of a space chord the app took", async () => {
      const output = paneOf(page, shells[0] ?? "").locator("[data-terminal]");
      await focusTerminal(1, "focus");
      // cat -v prints every byte it reads, control and Meta bytes as ^X / M-x, once a line ends.
      // Enter first: the Ctrl+L above is still on sh's input line, which does not clear the screen on it.
      await page.keyboard.type("\rprintf 'CAT%s\\n' READY; cat -v\r");
      await expect(output).toContainText("CATREADY", { timeout: 15_000 });
      await page.keyboard.press(await shortcut(page, "space.select:2"));
      await expect(tabBar(page)).toHaveText([/nine-2$/]);
      await focusTerminal(2, "focus");
      await page.keyboard.press(await shortcut(page, "space.select:1"));
      await expect(tabBar(page)).toHaveText([/nine-1$/]);
      await focusTerminal(1, "focus");
      await page.keyboard.type("END\r");
      await expect
        .poll(async () => {
          const text = (await output.textContent()) ?? "";
          return text.slice(text.lastIndexOf("CATREADY") + "CATREADY".length).replace(/\s+/g, "");
        })
        // The typed line, then cat's copy of it: a byte of either chord would come before one of them (^[2, M-1, 2).
        .toMatch(/^ENDEND/);
    });
  });
}
