import { devices, type Page } from "@playwright/test";
import { AGENT_SHELL, agentRow, startShell } from "./agents.ts";
import { removeTerminal } from "./ended-terminal.ts";
import { expect, opened, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  hcOn,
  machineRow,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

endOwnTerminals();

const header = (page: Page) => page.getByRole("banner");

function startShellIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", ...AGENT_SHELL]);
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

test("the session sheet offers Find in terminal only while its machine is online (#1482)", async ({ page }) => {
  test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
  const local = startShell("machine", "find-offline");
  try {
    await page.goto("/");
    // The phone lists machines on its Spaces tab (#1398); the agent row is back on Agents.
    const sections = page.getByRole("navigation", { name: "Sections" });
    await sections.getByRole("button", { name: "Spaces", exact: true }).click();
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    await sections.getByRole("button", { name: /^Agents\b/ }).click();
    await agentRow(page, "find-offline", true).click();
    const terminal = page.locator(`[data-terminal="${MACHINE_NAME}/${local}"]`);
    await expect(terminal).toContainText("$", { timeout: 15_000 });

    const actions = header(page).getByRole("button", { name: "Session actions for find-offline", exact: true });
    const sheet = page.getByRole("dialog", { name: "find-offline" });
    const find = sheet.getByRole("button", { name: "Find in terminal", exact: true });
    await actions.click();
    await opened(sheet);
    await expect(find).toBeVisible();
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await expect(sheet).toBeHidden();

    // Offline, the line under the header says so and the view waits for its machine, so it takes no terminal.search.
    switchTo("drop");
    await expect(page.getByRole("status").filter({ hasText: `${MACHINE_NAME} is offline` })).toBeVisible({
      timeout: OFFLINE_BOUND_MS,
    });
    await actions.click();
    await opened(sheet);
    await expect(find).toHaveCount(0);
    // The rest of the sheet still reaches the core, so it does not lose its rows with the terminal.
    await expect(sheet.getByRole("button", { name: "Rename…", exact: true })).toBeVisible();
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await expect(sheet).toBeHidden();

    // Back online, the terminal is drawn again and the row returns with it.
    reconnect();
    await expect(terminal).toContainText("$", { timeout: OFFLINE_BOUND_MS });
    await actions.click();
    await opened(sheet);
    await expect(find).toBeVisible();
  } finally {
    reconnect();
    removeTerminal("machine", local);
  }
});

test("a named tab's sheet and its trigger carry the name the header's heading reads (#1502)", async ({ page }) => {
  const run = Date.now().toString(36);
  const space = `pssn-${run}`;
  const shell = `pssn-shell-${run}`;
  const tab = `pssn-tab-${run}`;
  const address = startShellIn(space, shell);
  seedSpaces([{ id: "spc-pssn", name: space, folder: "", tabs: [{ id: "tb-pssn", name: tab, terminal: address }] }]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await agentRow(page, shell, false).click();
  await expect(header(page).getByRole("heading", { name: tab, exact: true })).toBeVisible({ timeout: 15_000 });
  const actions = header(page).getByRole("button", { name: `Session actions for ${tab}`, exact: true });
  await expect(actions).toBeVisible();
  await actions.click();
  await opened(page.getByRole("dialog", { name: tab, exact: true }));
});
