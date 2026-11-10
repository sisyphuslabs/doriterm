import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, startFakeRelayHost } from "./relay-route.ts";

// #1381 §8, PR 3: a browser reaches every member over the relay. The page refuses every WebSocket that is not the
// relay's, so a direct dial cannot succeed; the workspace and the mesh status still come up over the relay alone.
// A desktop browser and a phone (mobile emulation) both run it (design §14 item 3).
test.use({ serviceWorkers: "block" });

const SETTINGS_KEY = "doriface.connection";

/** The page's own sockets that are not the relay's. A direct dial lands here and is refused, which is the point. */
async function refuseEverySocketButTheRelay(page: Page): Promise<string[]> {
  const refused: string[] = [];
  // Registered before the relay's route below: Playwright tries the last route first, so the relay keeps its own.
  await page.routeWebSocket(/.*/, (socket) => {
    refused.push(socket.url());
    socket.close({ code: 1008, reason: "only the relay" });
  });
  return refused;
}

/** Pairs over the relay and keeps those settings across loads: the fixture seeds its own on every load. */
async function pairAndOpen(page: Page, host: FakeRelayHost): Promise<string> {
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click({ timeout: 30_000 });
  const paired = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  if (paired === null) throw new Error("pairing saved no connection");
  return paired;
}

/** The paired settings with a Direct address saved, as a file an older build or the desktop shell leaves them. */
async function withDirectAddress(page: Page, paired: string, directUrl: string): Promise<void> {
  const parsed: unknown = JSON.parse(paired);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("pairing saved no connection settings");
  const settings: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) settings[key] = Reflect.get(parsed, key);
  settings["directUrl"] = directUrl;
  const seeded: readonly [string, string] = [SETTINGS_KEY, JSON.stringify(settings)];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), seeded);
}

/**
 * The relay line the Add machine dialog offers, the one `doriface-host mesh join` takes. A desktop opens it from the
 * sidebar; a phone has no sidebar and opens it from Settings, Machines.
 */
async function joinOneMachine(page: Page, host: FakeRelayHost, phone: boolean): Promise<void> {
  if (phone) await openMachines(page);
  await page.getByRole("button", { name: phone ? "Add a machine" : "Add machine" }).click({ timeout: 60_000 });
  const dialog = page.getByRole("dialog", { name: "Add a machine" });
  const command = dialog.getByLabel("Join command");
  await expect(command).toBeVisible({ timeout: 30_000 });
  const text = (await command.innerText()).trim();
  const link = /DORIFACE_JOIN='(doriface:\/\/pair#[^']+)' sh$/.exec(text)?.[1] ?? "";
  expect(link).toContain("doriface://pair#");
  expect(await host.join(link)).toBe("joiner");
  await expect(dialog.getByText("joiner joined this host's mesh")).toBeVisible({ timeout: 60_000 });
}

async function openMachines(page: Page): Promise<void> {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Machines" })
    .or(page.getByRole("button", { name: "Machines" }))
    .first()
    .click();
}

/**
 * The only sockets a page may have refused are its own loopback probes for a host on the same computer (`/v1/hc`), which
 * design §8 keeps; anything else refused is a dial past the relay.
 */
function pastTheRelay(refused: readonly string[]): string[] {
  return refused.filter((url) => {
    const parsed = new URL(url);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    return !(loopback && parsed.pathname.startsWith("/v1/hc"));
  });
}

/** A desktop shows the terminal beside the list; a phone shows the agents list first, and a tap opens the terminal. */
async function terminalOpens(page: Page, phone: boolean): Promise<void> {
  if (phone)
    await page
      .getByRole("region", { name: "Agents" })
      .getByRole("button", { name: /existing/ })
      .first()
      .click({ timeout: 30_000 });
  await expect(page.locator("[data-terminal]").first()).toBeVisible({ timeout: 30_000 });
}

async function connectsOverTheRelayAlone(page: Page, phone: boolean): Promise<void> {
  const host = await startFakeRelayHost({ direct: true, terminal: true });
  try {
    const refused = await refuseEverySocketButTheRelay(page);
    await host.route(page);

    const paired = await pairAndOpen(page, host);
    // The session pairing proved is a browser session too: it says Relay, with no direct address saved at all.
    await expect(page.locator('[data-connection-path="relay"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("contentinfo")).toContainText("Relay");
    await terminalOpens(page, phone);

    // A later load with a Direct address in the file still reaches the host, and dials no direct socket to do it.
    await withDirectAddress(page, paired, host.directUrl);
    await page.goto("/");
    await expect(page.locator('[data-connection-path="relay"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("contentinfo")).toContainText("Relay");
    await terminalOpens(page, phone);

    await joinOneMachine(page, host, phone);
    await openMachines(page);
    // Once its host is in a mesh, the paired browser becomes a member itself (design 11) and lists every machine.
    const machines = page.getByRole("list", { name: "Machines" }).getByRole("listitem");
    await expect(machines.filter({ hasText: "studio" })).toContainText("Online · Relay", { timeout: 20_000 });
    await expect(machines.filter({ hasText: "joiner" })).toHaveCount(1, { timeout: 20_000 });

    // Every row is a relay row though the file still holds a direct address; the proof that nothing past the relay was
    // dialled is the refused-socket check below.
    await expect(machines.filter({ hasText: "joiner" })).toContainText("Relay");
    await expect(page.getByText(/Direct to this host|or direct to/)).toHaveCount(0);

    // Nothing but the relay was ever dialled: a direct attempt would be refused here, and it never happened. The only
    // refusals allowed are the loopback probes for a host on this computer.
    expect(refused.filter((url) => url.includes("/v1/e2ee"))).toEqual([]);
    expect(pastTheRelay(refused)).toEqual([]);
  } finally {
    await host.stop();
  }
}

test.describe("a desktop browser", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("connects over the relay alone and renders the workspace and the mesh status", async ({ page }) => {
    test.setTimeout(240_000);
    await connectsOverTheRelayAlone(page, false);
  });
});

test.describe("a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("connects over the relay alone and renders the workspace and the mesh status", async ({ page }) => {
    test.setTimeout(240_000);
    await connectsOverTheRelayAlone(page, true);
  });
});
