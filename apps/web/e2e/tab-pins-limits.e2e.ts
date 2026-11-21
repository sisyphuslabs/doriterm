// Pinned tabs at their limits (#1916, from the #1621 review): a pending close set whose tabs all got pinned elsewhere,
// and more pinned tabs than the strip has room for.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { updateCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { PINS_DOC, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

endOwnTerminals();

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");

function run(cwd: string, ...command: string[]): string {
  const out = hcOn("host", ["run", "--bg", "--cwd", cwd, "--", ...command]);
  return String((JSON.parse(out) as { address: string }).address);
}

/** Pins exactly these tabs, as another device writing the pins document does. */
const pinElsewhere = (...ids: string[]): void => updateCoreDoc(PINS_DOC, () => ({ pinned_tabs: ids }));

test("a close set whose tabs were all pinned on another device does not ask again when one is unpinned (#1916)", async ({
  page,
}) => {
  const folder = mkdtempSync(join(tmpdir(), "tab-pins-"));
  // Programs that run, so closing their tabs asks first.
  seedSpaces([
    {
      id: "spc-limits",
      name: "limits",
      folder,
      tabs: [
        { id: "tb-one", name: "one", terminal: run(folder, "env", "PS1=$ ", "sh") },
        { id: "tb-two", name: "two", terminal: run(folder, "sleep", "600") },
        { id: "tb-three", name: "three", terminal: run(folder, "sleep", "600") },
      ],
    },
  ]);
  await page.goto("/");
  await expect(tabBar(page)).toHaveText(["one", "two", "three"], { timeout: 20_000 });
  await tabBar(page).filter({ hasText: "one" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close tabs to the right", exact: true }).click();
  const question = page.getByRole("alertdialog").or(page.getByRole("dialog")).filter({ hasText: "Close 2 tabs?" });
  await expect(question).toBeVisible({ timeout: 15_000 });

  // Every tab of the set is pinned on another device: nothing is left to close, so the question goes.
  pinElsewhere("tb-two", "tb-three");
  await expect(question).toHaveCount(0, { timeout: 15_000 });
  await expect(tabBar(page).filter({ hasText: "three" })).toHaveAttribute("data-pinned", "");

  // Unpinning one later is not an answer to that question: it stays gone. The tab is read by its id, as a question up
  // again would hide the strip from the accessibility tree.
  pinElsewhere("tb-three");
  await expect(page.locator('[data-tab-id="tb-two"]')).not.toHaveAttribute("data-pinned", "", { timeout: 15_000 });
  await expect(page.getByRole("alertdialog").or(page.getByRole("dialog"))).toHaveCount(0);
});

test("more pinned tabs than the strip holds scroll in their own group, and the other tabs and New tab stay (#1916)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const folder = mkdtempSync(join(tmpdir(), "tab-pins-"));
  const pinned = Array.from({ length: 24 }, (_unused, at) => ({
    id: `tb-pin-${at}`,
    name: `pin ${at}`,
    terminal: run(folder, "env", "PS1=$ ", "sh"),
    pinned: true,
  }));
  seedSpaces([
    {
      id: "spc-limits",
      name: "limits",
      folder,
      tabs: [...pinned, { id: "tb-plain", name: "plain tab", terminal: run(folder, "env", "PS1=$ ", "sh") }],
    },
  ]);
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(25, { timeout: 20_000 });
  await tabBar(page).filter({ hasText: "plain tab" }).click();
  await expect(tabBar(page).filter({ hasText: "plain tab" })).toHaveAttribute("aria-selected", "true");

  const geometry = await page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Tabs"]');
    const pins = document.querySelector<HTMLElement>("[data-tab-pins]");
    const rest = document.querySelector<HTMLElement>("[data-tab-scroll]");
    const plain = rest?.querySelector<HTMLElement>("[data-tab-id]")?.getBoundingClientRect();
    return {
      stripOverflows: strip === null ? true : strip.scrollWidth > strip.clientWidth + 1,
      pinsScroll: pins === null ? false : pins.scrollWidth > pins.clientWidth + 1,
      plainShown: plain !== undefined && rest !== null && plain.width > 0 && rest.clientWidth >= plain.width,
    };
  });
  expect(geometry).toEqual({ stripOverflows: false, pinsScroll: true, plainShown: true });
  await expect(page.getByRole("button", { name: "New tab" })).toBeInViewport();
});
