import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { startFakeRelayHost, type FakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

/** How long a loading or reconnecting message, once shown, stays at the least (INDICATOR_MIN_MS, #2768). */
const HELD_MS = 500;

const WORDS = /Loading[^\n]*…|Connecting[^\n]*|Reconnecting[^\n]*/;

interface Span {
  readonly text: string;
  readonly from: number;
  readonly to: number | null;
}

async function watchIndicators(page: Page): Promise<void> {
  await page.addInitScript((source) => {
    const words = new RegExp(source);
    const open = new Map<string, number>();
    const spans: { text: string; from: number; to: number | null }[] = [];
    const scan = (): void => {
      const now = performance.now();
      const seen = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent === null || parent.closest("[data-terminal] .term-grid") !== null) continue;
        const style = getComputedStyle(parent);
        if (style.visibility === "hidden" || style.display === "none" || parent.getClientRects().length === 0) continue;
        const match = words.exec(node.textContent ?? "");
        if (match !== null) seen.add(match[0].trim());
      }
      for (const text of seen) if (!open.has(text)) open.set(text, now);
      for (const [text, from] of open) {
        if (seen.has(text)) continue;
        open.delete(text);
        spans.push({ text, from, to: now });
      }
    };
    const start = (): void => {
      new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
      scan();
    };
    if (document.body === null) addEventListener("DOMContentLoaded", start, { once: true });
    else start();
    Reflect.set(globalThis, "__indicators", () => {
      const now = performance.now();
      return {
        now,
        spans: [...spans, ...[...open].map(([text, from]) => ({ text, from, to: null }))],
      };
    });
  }, WORDS.source);
}

const indicators = (page: Page): Promise<{ now: number; spans: Span[] }> =>
  page.evaluate(() => (Reflect.get(globalThis, "__indicators") as () => { now: number; spans: Span[] })());

async function pairAndOpen(page: Page, host: FakeRelayHost): Promise<Locator> {
  await page.goto(await host.pairingLink());
  await page.getByRole("button", { name: "They match" }).click({ timeout: 30_000 });
  await expect(page.getByRole("status").getByText("Paired")).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("link", { name: "Open terminals" })
    .or(page.getByRole("button", { name: "Open terminals" }))
    .click({ timeout: 30_000 });
  await page
    .getByRole("region", { name: "Agents" })
    .getByRole("button", { name: /^Idle / })
    .first()
    .click({ timeout: 30_000 });
  const terminal = page.locator("[data-terminal]").first();
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(terminal).toContainText("$", { timeout: 30_000 });
  return terminal;
}

// #2768: a cold reload's "Connecting to your host", "Loading the workspace…" and "Loading agents…" each flashed for
// 25-307 ms. A wait under a second now shows nothing, and a message that does show stays at least half a second.
test("a cold reload shows no loading message that blinks: none, or each held at least half a second", async ({
  page,
}) => {
  await watchIndicators(page);
  const host = await startFakeRelayHost({ terminal: true });
  try {
    await host.route(page);
    await pairAndOpen(page, host);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await indicators(page)).spans.filter((span) => span.to === null).length).toBe(0);
    const blinks = (await indicators(page)).spans
      .map((span) => ({ text: span.text, visibleMs: Math.round((span.to ?? 0) - span.from) }))
      .filter((span) => span.visibleMs < HELD_MS);
    expect(blinks).toEqual([]);
  } finally {
    await host.stop();
  }
});
