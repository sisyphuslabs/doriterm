// A tab switch made from the keyboard moves the keyboard with it: the terminal it shows takes focus as part of the switch,
// so the first key typed after it lands there with no click (#1704). Each test types straight after the switch, with
// nothing focusing the new terminal for it.
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { shortcut } from "./platform-keys.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "tsf1704";
const NAMES = ["one", "two", "three"] as const;
type Name = (typeof NAMES)[number];

const strip = (page: Page) => page.getByRole("tablist", { name: "Tabs" });
const tabOf = (page: Page, name: Name) => strip(page).getByRole("tab").filter({ hasText: name });
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const combobox = (page: Page) => palette(page).getByRole("combobox");

function startShell(name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${SPACE}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** Three tabs in one space, one shell each, the first selected and its terminal holding the keyboard. */
async function threeTabs(page: Page): Promise<Record<Name, string>> {
  const addresses = { one: startShell("tsf-one"), two: startShell("tsf-two"), three: startShell("tsf-three") };
  seedSpaces([
    {
      folder: "",
      id: `spc-${SPACE}`,
      name: SPACE,
      tabs: NAMES.map((name) => ({ id: `tb-tsf-${name}`, name, terminal: addresses[name] })),
    },
  ]);
  await page.goto("/");
  await expect(strip(page).getByRole("tab")).toHaveCount(3, { timeout: 20_000 });
  await expect(tabOf(page, "one")).toHaveAttribute("aria-selected", "true");
  const first = terminal(page, addresses.one);
  await expect(first).toContainText("$", { timeout: 15_000 });
  await first.getByRole("textbox").focus();
  await expect(first.getByRole("textbox")).toBeFocused();
  return addresses;
}

const terminal = (page: Page, address: string): Locator => page.locator(`[data-terminal="${address}"]`);

/** Types a line straight away, with no click: it must reach `to` in full, its first key included, and not `from`. */
async function typedReaches(page: Page, to: string, from: string, marker: number): Promise<void> {
  await page.keyboard.type(`echo tsf$((${marker}+1))`, { delay: 40 });
  await page.keyboard.press("Enter");
  await expect(terminal(page, to)).toContainText(`tsf${marker + 1}`, { timeout: 15_000 });
  await expect(terminal(page, to)).toContainText(`echo tsf$((${marker}+1))`);
  await expect(terminal(page, to).getByRole("textbox")).toBeFocused();
  await expect(terminal(page, from)).not.toContainText(`tsf$((${marker}`);
}

const CHORDS = [
  { action: "tab.select:2", to: "two" },
  { action: "tab.next", to: "two" },
  { action: "tab.prev", to: "three" },
  { action: "agent.next", to: "two" },
  { action: "agent.prev", to: "three" },
] as const;

for (const [index, { action, to }] of CHORDS.entries()) {
  test(`${action} from the keyboard puts the keyboard in the terminal it shows`, async ({ page }) => {
    const addresses = await threeTabs(page);
    await page.keyboard.press(await shortcut(page, action));
    await expect(tabOf(page, to)).toHaveAttribute("aria-selected", "true");
    await typedReaches(page, addresses[to], addresses.one, 100 + index * 10);
  });
}

test("opening an agent from the palette puts the keyboard in its terminal", async ({ page }) => {
  const addresses = await threeTabs(page);
  await page.keyboard.press(await shortcut(page, "app.palette"));
  await combobox(page).fill("tsf-three");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(tabOf(page, "three")).toHaveAttribute("aria-selected", "true");
  await typedReaches(page, addresses.three, addresses.one, 300);
});

test("the next agent that needs you, from the palette, puts the keyboard in its terminal", async ({ page }) => {
  const addresses = await threeTabs(page);
  hcOn("host", ["send", "--force", addresses.three, "printf '\\033]7501;state=blocked\\033\\\\'"]);
  await expect(page.getByRole("contentinfo").getByRole("button", { name: /needs you$/ })).toBeVisible({
    timeout: 15_000,
  });
  await terminal(page, addresses.one).getByRole("textbox").focus();
  await page.keyboard.press(await shortcut(page, "app.palette"));
  await combobox(page).fill("Open the next agent that needs you");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(tabOf(page, "three")).toHaveAttribute("aria-selected", "true");
  await typedReaches(page, addresses.three, addresses.one, 400);
});

test("a tab switch under the open palette leaves its field the keyboard until it closes", async ({ page }) => {
  const addresses = await threeTabs(page);
  await page.keyboard.press(await shortcut(page, "app.palette"));
  await expect(combobox(page)).toBeFocused();
  await page.keyboard.type("abc");
  await page.keyboard.press(await shortcut(page, "tab.select:2"));
  await page.keyboard.type("d");
  await expect(combobox(page)).toBeFocused();
  await expect(combobox(page)).toHaveValue("abcd");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  const shown = (await tabOf(page, "two").getAttribute("aria-selected")) === "true" ? "two" : "one";
  await typedReaches(page, addresses[shown], shown === "two" ? addresses.one : addresses.two, 500);
});
