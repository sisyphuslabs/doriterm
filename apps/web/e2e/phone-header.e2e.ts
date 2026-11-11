import { devices, type Page } from "@playwright/test";
import { AGENT_SHELL, agentRow, endAgent } from "./agents.ts";
import { expect, laidOutBox, opened, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

const header = (page: Page) => page.getByRole("banner");

/** The stand-in agent (`AGENT_SHELL`) in a space of its own, started straight on the e2e core; it reports a state only when told to. */
function startShellIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", ...AGENT_SHELL]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** Types into the shell a command that reports `state` over OSC 7501, as an agent does when its turn changes. */
function report(address: string, state: string): void {
  hcOn("host", ["send", address, `printf '\\033]7501;state=${state}\\033\\\\'`]);
}

test("on a phone the terminal header names the session and where it is, follows its state live, and switches tabs", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const space = `hdr-${run}`;
  const first = `hdr-a-${run}`;
  const second = `hdr-b-${run}`;
  const started = [startShellIn(space, first), startShellIn(space, second)];
  // The space as the layout saves it (#404): one tab per shell, in this order.
  const saveSpace = (): void =>
    seedSpaces([
      {
        id: "spc-hdr",
        name: space,
        folder: "",
        tabs: started.map((terminal, index) => ({ id: `tb-hdr-${index}`, name: "", terminal })),
      },
    ]);
  try {
    saveSpace();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await agentRow(page, first, false).click();
    // These tabs have no name, so the heading reads the terminal's own name, never the tab's place (#1387 plan, phase 2).
    await expect(header(page).getByRole("heading", { name: first, exact: true })).toBeVisible({ timeout: 15_000 });
    // How many agents are done, working and idle is the agents list's to say, not a session's header.
    await expect(header(page).locator("[data-agent-counts]")).toHaveCount(0);

    // Where: the space, and this tab's place among the space's tabs.
    await expect(header(page).getByText(new RegExp(` · ${space}$`))).toBeVisible();
    // The tab's place is the bottom tabs bar's, not the header's (#466).
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toContainText("1/2");
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toHaveAccessibleName(
      /tab 1 of 2$/,
    );

    // The header follows the open session's own state as hc reports it, without a reload.
    const shown = started[0];
    if (shown === undefined) throw new Error("no first terminal started");
    // Needs you: a still glyph, so the sheet opened below settles (a working spinner never stops).
    report(shown, "blocked");
    await expect(
      header(page)
        .getByRole("img", { name: "Needs you" })
        .or(header(page).getByText("Needs you", { exact: true }))
        .first(),
    ).toBeAttached({ timeout: 15_000 });

    // The bottom tabs bar's switch opens the spaces and their tabs (the header has none: one strip, #466); picking another
    // tab opens it and moves the position.
    // By the switch's name pattern: a switch in the header whose name starts with "Switch" fails here (#2356).
    await expect(header(page).getByRole("button", { name: /^Switch/ })).toHaveCount(0);
    const switcher = page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });
    const box = await laidOutBox(switcher);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await switcher.click();
    const sheet = page.getByRole("dialog", { name: "Switch" });
    await opened(sheet);
    // A visible Done closes the sheet and hands focus back to the switch.
    // Exact: an agent row's name also carries its state, "Done" among them.
    const done = sheet.getByRole("button", { name: "Done", exact: true });
    const doneBox = await laidOutBox(done);
    expect(doneBox.width).toBeGreaterThanOrEqual(44);
    expect(doneBox.height).toBeGreaterThanOrEqual(44);
    await done.click();
    await expect(sheet).toBeHidden();
    await expect(switcher).toBeFocused();
    await switcher.click();
    await expect(sheet).toBeVisible();
    const section = sheet.getByRole("region", { name: space });
    // The rows name the tabs by their terminals, as the header does: these tabs have no name of their own.
    const tabRow = (title: string) =>
      section.getByRole("button").filter({ has: page.locator(`[data-floor="name"][title="${title}"]`) });
    await expect(tabRow(first)).toHaveAttribute("aria-current", "true");
    await tabRow(second).click();
    await expect(sheet).toBeHidden();
    await expect(header(page).getByRole("heading", { name: second, exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toContainText("2/2");

    // A new tab in the same space, saved by another device, is counted at once.
    started.push(startShellIn(space, `hdr-c-${run}`));
    saveSpace();
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toContainText(
      "2/3",
      { timeout: 15_000 },
    );
  } finally {
    for (const address of started) endAgent("host", address);
  }
});
