// #2532: a phone paired with two machines shows a terminal on one of them. When that machine's link drops, the phone
// stays on the terminal and says it reconnects; it never moves to the other machine. A page the browser discarded and
// loads again at the terminal's address while that machine is down waits for it there, and comes back to the terminal.
import type { Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { type FakeRelayHost, type RelayObserver, startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

/** A host's relay link as the spec holds it: while `down`, every socket to the host is dropped as it opens. */
class Link {
  down = false;
  refused = 0;
  /** Messages the relay has delivered from the host: the other machine's link is up once they arrive. */
  heard = 0;
  readonly #open = new Set<() => void>();

  readonly observer: RelayObserver = {
    fromRelay: () => {
      this.heard += 1;
    },
    opened: (socket) => {
      const drop = (): void => socket.drop(1006, "relay blip");
      if (!this.down) {
        this.#open.add(drop);
        return;
      }
      this.refused += 1;
      drop();
    },
  };

  cut(): void {
    this.down = true;
    for (const drop of this.#open) drop();
    this.#open.clear();
  }
}

const stored = (page: Page): Promise<string> => page.evaluate(() => localStorage.getItem("doriface.connection") ?? "");

const savedHost = async (page: Page): Promise<string> => (JSON.parse(await stored(page)) as { hostId: string }).hostId;

/** Pairs the page with `host` over its relay, as a person does with a pairing link; returns the host's id. */
async function pair(page: Page, host: FakeRelayHost, observer?: RelayObserver): Promise<string> {
  await host.route(page, observer);
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  return savedHost(page);
}

/**
 * Records, from now on (and in a page loaded after this), every moment the phone shows a list or the space loader
 * instead of a terminal: a MutationObserver sees each, however short.
 */
const RECORD_LEAVES = (): void => {
  const leaves: string[] = [];
  Object.assign(window, { leaves });
  const check = (): void => {
    const heading = document.querySelector("h1")?.textContent ?? "";
    if (heading === "Agents" || heading === "Spaces") leaves.push(`list: ${heading}`);
    if ((document.body.textContent ?? "").includes("Loading the space")) leaves.push("space loader");
  };
  const watch = (): void =>
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
};

const leaves = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...new Set((window as unknown as { leaves: string[] }).leaves)]);

const terminal = (page: Page) => page.locator("[data-terminal]").first();
const tabParam = (page: Page): string | null => new URL(page.url()).searchParams.get("t");

test.describe("a phone with two machines, on a terminal of one (#2532)", () => {
  let shown: FakeRelayHost | undefined;
  let other: FakeRelayHost | undefined;
  test.afterEach(async () => {
    await Promise.all([shown?.stop(), other?.stop()]);
    shown = undefined;
    other = undefined;
  });

  /** Pairs the other machine first, then the shown one, so the shown one is selected; opens its terminal. */
  async function onTerminal(page: Page, link: Link, otherLink = new Link()): Promise<string> {
    [shown, other] = await Promise.all([startFakeRelayHost({ terminal: true }), startFakeRelayHost()]);
    const otherId = await pair(page, other);
    const shownId = await pair(page, shown, link.observer);
    await other.route(page, otherLink.observer, otherId);
    // The fixture seeds loopback settings on every load: seed the two paired machines instead.
    await page.addInitScript((value) => localStorage.setItem("doriface.connection", value), await stored(page));
    await page.goto("/");
    await agentRow(page, "existing", false).click({ timeout: 30_000 });
    await expect(terminal(page)).toBeVisible({ timeout: 20_000 });
    expect(tabParam(page)).not.toBeNull();
    return shownId;
  }

  test("a drop keeps the terminal on screen, says Reconnecting, and comes back to it", async ({ page }) => {
    test.setTimeout(180_000);
    const link = new Link();
    const shownId = await onTerminal(page, link);
    const tab = tabParam(page);
    await page.evaluate(RECORD_LEAVES);

    link.cut();
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting" }).first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => link.refused, { timeout: 30_000 }).toBeGreaterThan(1);
    await expect(terminal(page)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("reconnecting-phone.png") });

    link.down = false;
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toHaveCount(0, { timeout: 30_000 });
    await expect(terminal(page)).toBeVisible();
    expect(tabParam(page)).toBe(tab);
    expect(await leaves(page)).toEqual([]);
    expect(await savedHost(page)).toBe(shownId);
  });

  test("a page loaded again at the terminal while its machine is down waits there and resumes it", async ({ page }) => {
    test.setTimeout(180_000);
    const link = new Link();
    const otherLink = new Link();
    const shownId = await onTerminal(page, link, otherLink);
    const tab = tabParam(page);
    const address = await terminal(page).getAttribute("data-terminal");

    // As a phone that discarded the page in the background: the link is gone, and the page loads again where it was.
    link.cut();
    await page.addInitScript(RECORD_LEAVES);
    const heard = otherLink.heard;
    await page.reload();
    // The other machine answers this load while the terminal's machine keeps refusing: two refusals after that are two
    // failures of the shown machine with another one open, each a moment the app could move to it.
    await expect.poll(() => otherLink.heard, { timeout: 30_000 }).toBeGreaterThan(heard);
    const refused = link.refused;
    await expect.poll(() => link.refused, { timeout: 30_000 }).toBeGreaterThan(refused + 1);
    await page.screenshot({ path: test.info().outputPath("reload-waiting-phone.png") });
    expect(await leaves(page)).toEqual([]);
    expect(await savedHost(page)).toBe(shownId);

    link.down = false;
    await expect(page.locator(`[data-terminal="${address}"]`)).toBeVisible({ timeout: 30_000 });
    expect(tabParam(page)).toBe(tab);
    expect(await leaves(page)).toEqual([]);
    expect(await savedHost(page)).toBe(shownId);
  });
});
