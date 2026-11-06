import type { Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn, STATE_BOUND_MS } from "./machine-switch.ts";
import { domOrder, tabs } from "./tab-strip.ts";

const RENAMED = "build-renamed";
const localOf = (address: string): string => address.slice(address.indexOf("/") + 1);

const selectedPane = (page: Page, address: string) =>
  page.locator(`[role="tabpanel"]:not([hidden]) [data-terminal="${address}"]`);

const stripNames = (page: Page): Promise<string[]> => tabs(page).allInnerTexts();

/** Shows the strip's tab at `place` and types into its pane, proving the terminal answers at `address`. */
async function answerAt(page: Page, place: number, address: string, typed: string): Promise<void> {
  await tabs(page).nth(place).click();
  const pane = selectedPane(page, address);
  await expect(pane).toBeVisible({ timeout: 15_000 });
  await pane.click();
  await page.keyboard.type(`echo ${typed}-$((40 + 2))\r`);
  await expect(pane).toContainText(`${typed}-42`, { timeout: 15_000 });
}

const frameText = (message: string | Buffer): string =>
  typeof message === "string" ? message : message.toString("latin1");

/** Names the strip's tab at `place` through the dialog a double-click opens, as a person renames one (#466). */
async function nameTab(page: Page, place: number, name: string): Promise<void> {
  await tabs(page).nth(place).dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("textbox").press("Enter");
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(tabs(page).nth(place)).toHaveText(name, { timeout: 10_000 });
}

/**
 * Holds the core's answer to the page's first read of the added machine's layout until `release`, so a terminal opened
 * meanwhile finds that layout still loading and gets a tab of this screen's own (#459).
 */
async function holdMachineLayout(page: Page): Promise<{ readonly release: () => void }> {
  const held: (() => void)[] = [];
  let holding = true;
  let asked: RegExp | undefined;
  await page.routeWebSocket(/\/v1\/hc/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const sent = frameText(message);
      const id = /"id":(\d+),"method":"doc\.get"/.exec(sent)?.[1];
      if (holding && asked === undefined && id !== undefined && sent.includes(`"on":"${MACHINE_NAME}"`))
        asked = new RegExp(`"id":${id}[,}]`);
      server.send(message);
    });
    server.onMessage((message) => {
      if (holding && asked?.test(frameText(message)) === true) held.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  return {
    release: () => {
      holding = false;
      for (const send of held.splice(0)) send();
    },
  };
}

test.describe("renaming a machine with two tabs open", () => {
  let local = "";
  let remote = "";
  let second = "";
  let renamed = false;
  test.beforeEach(() => {
    remote = startShell("machine", "e2e");
    second = startShell("machine", "second");
  });
  test.afterEach(() => {
    if (renamed) hcOn("host", ["machine", "rename", RENAMED, MACHINE_NAME]);
    renamed = false;
    endAgent("machine", second);
    endAgent("machine", remote);
    if (local !== "") endAgent("host", local);
    local = "";
  });

  test("keeps both tabs of the space, their names, order and panes", async ({ page }) => {
    local = startShell("host", "home");
    await page.goto("/");
    await agentRow(page, "home", false).click();
    await agentRow(page, "e2e", true).click();
    await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`)).toBeVisible({ timeout: 20_000 });
    await agentRow(page, "second", true).click();
    await expect(tabs(page)).toHaveCount(2, { timeout: STATE_BOUND_MS });
    await nameTab(page, 0, "build");
    await nameTab(page, 1, "logs");
    const order = await domOrder(page);

    hcOn("host", ["machine", "rename", MACHINE_NAME, RENAMED]);
    renamed = true;
    await expect(page.locator(`[data-terminal="${RENAMED}/${second}"]`)).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(tabs(page)).toHaveCount(2);
    expect(await stripNames(page)).toEqual(["build", "logs"]);
    expect(await domOrder(page)).toEqual(order);
    await answerAt(page, 0, `${RENAMED}/${remote}`, "first");
    await answerAt(page, 1, `${RENAMED}/${second}`, "second");
    await expect(tabs(page)).toHaveCount(2);
  });

  test("keeps both when the first was opened while the machine's layout was loading", async ({ page }) => {
    local = startShell("host", "home");
    const layout = await holdMachineLayout(page);
    await page.goto("/");
    await agentRow(page, "home", false).click();
    await agentRow(page, "e2e", true).click();
    await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`)).toBeVisible({ timeout: 20_000 });
    layout.release();
    await expect(tabs(page)).toHaveCount(2, { timeout: STATE_BOUND_MS });
    await nameTab(page, 0, "build");
    await nameTab(page, 1, "logs");
    const order = await domOrder(page);

    hcOn("host", ["machine", "rename", MACHINE_NAME, RENAMED]);
    renamed = true;
    await expect(page.locator(`[data-terminal="${RENAMED}/${second}"]`)).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(tabs(page)).toHaveCount(2);
    expect(await stripNames(page)).toEqual(["build", "logs"]);
    expect(await domOrder(page)).toEqual(order);
    await tabs(page).nth(0).click();
    await expect(selectedPane(page, `${RENAMED}/${remote}`)).toBeVisible({ timeout: 15_000 });
  });

  test("keeps two tabs the machine's layout had when the rename lands while it loads", async ({ page }) => {
    seedSpaces(
      [
        {
          id: "spc-strip",
          name: "api",
          folder: "/tmp",
          tabs: [
            { id: "tb-strip-one", name: "one", terminal: localOf(remote) },
            { id: "tb-strip-two", name: "two", terminal: localOf(second) },
          ],
        },
      ],
      MACHINE_NAME,
    );
    const layout = await holdMachineLayout(page);
    await page.goto("/");
    await expect(page.getByRole("tablist", { name: "Tabs" })).toBeVisible({ timeout: 20_000 });

    hcOn("host", ["machine", "rename", MACHINE_NAME, RENAMED]);
    renamed = true;
    layout.release();
    await expect(tabs(page)).toHaveCount(2, { timeout: STATE_BOUND_MS });
    expect(await stripNames(page)).toEqual(["one", "two"]);
    await tabs(page).nth(0).click();
    await expect(selectedPane(page, `${RENAMED}/${remote}`)).toBeVisible({ timeout: 15_000 });
    await tabs(page).nth(1).click();
    await expect(selectedPane(page, `${RENAMED}/${second}`)).toBeVisible({ timeout: 15_000 });
  });
});
