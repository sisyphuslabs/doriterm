// The phone's round button (Read-only on a touch device: its keys panel carries the keyboard's toggle, #2499) floats
// level with the tabs bar; the bar keeps its right end clear of it, so every one of its targets and its own takes a tap
// (#1396).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { key, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

endOwnTerminals();

function shellIn(cwd: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  return String((JSON.parse(out) as { address: string }).address);
}

function oneSpaceTwoTabs(): void {
  const folder = mkdtempSync(join(tmpdir(), "round-buttons-"));
  seedSpaces([
    {
      id: "spc-round",
      name: "round",
      folder,
      tabs: [
        { id: "tb-r1", name: "r-one", terminal: shellIn(folder, "round-r1") },
        { id: "tb-r2", name: "r-two", terminal: shellIn(folder, "round-r2") },
      ],
    },
  ]);
}

type Box = Awaited<ReturnType<typeof laidOutBox>>;
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const heading = (page: Page, name: string): Locator =>
  page.getByRole("banner").getByRole("heading", { name, exact: true });

// No inset, an iPhone's home indicator, and a right inset as a landscape notch adds: the clearance follows both.
const insets = [
  { bottom: 0, right: 0 },
  { bottom: 34, right: 0 },
  { bottom: 21, right: 47 },
] as const;

for (const inset of insets) {
  test(`at 390x844 with a ${inset.bottom}px bottom and ${inset.right}px right inset, Read-only covers no tab control and Next tab takes a tap with it off and on`, async ({
    page,
  }) => {
    oneSpaceTwoTabs();
    await page.goto("/");
    await page.addStyleTag({
      content: `:root:root { --safe-bottom: ${inset.bottom}px; --safe-right: ${inset.right}px; }`,
    });
    await agentRow(page, "round-r1", false).click();
    await expect(heading(page, "r-one")).toBeVisible({ timeout: 15_000 });
    const bar = page.getByRole("navigation", { name: "Tabs in this space" });
    const readOnly = key(page, "Read-only");
    const round = [readOnly];
    const controls = [
      bar.getByRole("button", { name: "Previous tab" }),
      bar.getByRole("button", { name: /^Switch tab, / }),
      bar.getByRole("button", { name: "Next tab" }),
    ];
    const roundBoxes = await Promise.all(round.map(laidOutBox));
    for (const box of roundBoxes) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    for (const box of await Promise.all(controls.map(laidOutBox))) {
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      for (const other of roundBoxes) expect(overlaps(box, other)).toBe(false);
    }

    const next = bar.getByRole("button", { name: "Next tab" });
    await next.tap();
    await expect(heading(page, "r-two")).toBeVisible({ timeout: 15_000 });
    // Browsing keeps Read-only in its slot, pressed, and the bar beneath it: the next tab is still a tap away.
    await readOnly.tap();
    await expect(readOnly).toHaveAttribute("aria-pressed", "true");
    await expect(bar).toBeVisible();
    await next.tap();
    await expect(heading(page, "r-one")).toBeVisible({ timeout: 15_000 });
    await expect(readOnly).toHaveAttribute("aria-pressed", "false");
  });
}
