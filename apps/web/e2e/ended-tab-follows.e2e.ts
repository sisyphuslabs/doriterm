import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { startKeptShell, startShell } from "./agents.ts";
import { removeTerminal, stateOn } from "./ended-terminal.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { paneOf, savedTab, seedLayout } from "./layout-doc.ts";
import { hcOn, STATE_BOUND_MS } from "./machine-switch.ts";
import { shortcut } from "./platform-keys.ts";

// A tab mirrors its terminal (Q, 2026-11-15): once the core says its program is over, for whatever reason, the tab goes
// without a reload, and a pane left saying "This session ended" (its drop's layout write was refused) closes when the
// person closes it (#2986).

test.use({ serviceWorkers: "block" });

const started: string[] = [];
test.afterEach(() => {
  for (const address of started.splice(0)) removeTerminal("host", address);
});

const shell = (start: typeof startShell, name: string): string => {
  const address = start("host", name);
  started.push(address);
  return address;
};

const record = (address: string): Record<string, unknown> =>
  JSON.parse(hcOn("host", ["get", address, "--json"])) as Record<string, unknown>;

const tab = (page: Page, name: RegExp) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name });

test("a tab whose program was lost with its holder while the page never showed it goes without a reload", async ({
  page,
}) => {
  const kept = shell(startKeptShell, "rpc-kept");
  const lost = shell(startShell, "rpc-lost");
  seedLayout([
    { id: "tb-kept", name: "kept", root: [{ pane: "p1", terminal: kept }] },
    { id: "tb-lost", name: "lost", root: [{ pane: "p2", terminal: lost }] },
  ]);
  await page.goto("/");
  await tab(page, /kept/).click();
  await expect(paneOf(page, kept)).toContainText("$", { timeout: 15_000 });
  await expect(tab(page, /lost/)).toHaveCount(1);

  // The holder running the shell dies: hc ends the plain shell for good (holder_lost) and revives the kept one.
  const holder = execFileSync("ps", ["-o", "ppid=", "-p", String(record(lost)["pid"])], { encoding: "utf8" }).trim();
  execFileSync("kill", ["-KILL", holder]);
  await expect.poll(() => stateOn("host", lost), { timeout: 15_000 }).toBe("finished");
  expect(record(lost)["reason"]).toBe("holder_lost");

  await expect.poll(() => savedTab("tb-lost"), { timeout: STATE_BOUND_MS }).toBeNull();
  await expect(tab(page, /lost/)).toHaveCount(0);
  await expect(tab(page, /kept/)).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "This session ended" })).toHaveCount(0);
});

/** Two tabs of one space, `solo` in view; its program exits while every layout write is refused, so its pane stays. */
async function endedWhileRefused(page: Page): Promise<void> {
  const socket = await routeHcSocket(page);
  const other = shell(startShell, "ended-other");
  const solo = shell(startShell, "ended-solo");
  seedLayout([
    { id: "tb-other", name: "other", root: [{ pane: "p1", terminal: other }] },
    { id: "tb-solo", name: "solo", root: [{ pane: "p2", terminal: solo }] },
  ]);
  await page.goto("/");
  await tab(page, /solo/).click();
  await expect(paneOf(page, solo)).toContainText("$", { timeout: 15_000 });
  await paneOf(page, solo).getByRole("textbox").focus();
  socket.staleWrites(true);
  await page.keyboard.type("exit\r");
  await expect(page.getByText("The layout was not saved")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "This session ended" })).toBeVisible();
  expect(savedTab("tb-solo")).not.toBeNull();
  socket.staleWrites(false);
}

test("Close tab on a pane whose session ended removes its tab", async ({ page }) => {
  await endedWhileRefused(page);
  await page.getByRole("button", { name: "Close tab", exact: true }).click();
  await expect.poll(() => savedTab("tb-solo"), { timeout: 15_000 }).toBeNull();
  await expect(tab(page, /solo/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "This session ended" })).toHaveCount(0);
});

test("the Close tab key on a tab whose session ended removes it", async ({ page }) => {
  await endedWhileRefused(page);
  await page.keyboard.press(await shortcut(page, "tab.close"));
  await expect.poll(() => savedTab("tb-solo"), { timeout: 15_000 }).toBeNull();
  await expect(tab(page, /solo/)).toHaveCount(0);
});
