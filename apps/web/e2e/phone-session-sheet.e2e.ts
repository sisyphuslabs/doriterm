import { devices, type Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { expect, opened, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

endOwnTerminals();

const header = (page: Page) => page.getByRole("banner");

function startShellIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

/** hc refuses to type into a blocked terminal unless forced. */
function report(address: string, state: string): void {
  hcOn("host", ["send", "--force", address, `printf '\\033]7501;state=${state}\\033\\\\'`]);
}

test("the phone header's ... is one sheet: where the session lives, the next agent, find, rename, end (#1467)", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const space = `pss-${run}`;
  const here = `pss-here-${run}`;
  const asks = `pss-asks-${run}`;
  const started = [startShellIn(space, here), startShellIn(space, asks)];
  seedSpaces([
    {
      id: "spc-pss",
      name: space,
      folder: "",
      tabs: started.map((terminal, index) => ({ id: `tb-pss-${index}`, name: "", terminal })),
    },
  ]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await agentRow(page, here, false).click();
  const actions = header(page).getByRole("button", { name: `Session actions for ${here}`, exact: true });
  await expect(actions).toBeVisible({ timeout: 15_000 });

  await actions.click();
  const sheet = page.getByRole("dialog", { name: here });
  await opened(sheet);
  await expect(sheet.locator("[data-session-place]")).toContainText(space);
  await expect(sheet.getByRole("button", { name: /^Open the next agent that needs you/ })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Find in terminal", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("searchbox", { name: "Find in terminal" })).toBeFocused();
  await page.keyboard.press("Escape");

  await actions.click();
  await opened(sheet);
  await sheet.getByRole("button", { name: "Rename…", exact: true }).click();
  const rename = page.getByRole("dialog", { name: `Rename ${here}` });
  await expect(rename).toBeVisible();
  await rename.getByRole("button", { name: "Cancel" }).click();

  report(started[1] ?? "", "blocked");
  await actions.click();
  await opened(sheet);
  await sheet.getByRole("button", { name: "Open the next agent that needs you (1)", exact: true }).click();
  await expect(header(page).getByRole("button", { name: `Session actions for ${asks}`, exact: true })).toBeVisible({
    timeout: 15_000,
  });
  report(started[1] ?? "", "working");
});
