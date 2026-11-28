import { devices, type Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { type AskingAgent, startAskingAgent } from "./approval-agent.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { stubSpeech } from "./speech-stub.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

let agent: AskingAgent | undefined;
test.afterEach(() => {
  agent?.end();
  agent = undefined;
});

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (found === null) throw new Error(`${selector} has no box`);
  return found;
};

test("at 390, the approval banner keeps the top and the voice strip the bottom, both usable at once", async ({
  page,
}) => {
  const name = `asks-${crypto.randomUUID().slice(0, 8)}`;
  agent = startAskingAgent(name);
  const asking = agent;
  const settled = Promise.withResolvers<void>();
  let settlementId: string | undefined;
  await routeHcSocket(page, {
    sent: (frame) => {
      if (frame.includes(`"name":"approval.${asking.address}"`) && frame.includes('"outcome":"sent"')) {
        settlementId = /"id":(\d+),"method":"doc\.set"/.exec(frame)?.[1];
      }
    },
    received: (frame) => {
      if (settlementId !== undefined && frame.includes(`"id":${settlementId},`) && frame.includes('"result"'))
        settled.resolve();
    },
  });
  await stubSpeech(page);
  await page.goto("/");
  await agentRow(page, name, false).click();
  const banner = page.locator(`[data-approval="${asking.address}"]`);
  await expect(banner).toContainText("touch probe-a.txt", { timeout: 15_000 });

  // Dictation into the same terminal, through its own first-use question.
  await page
    .getByRole("banner")
    .getByRole("button", { name: `Dictate into ${name}` })
    .click();
  const strip = page.locator("[data-voice-strip]");
  await strip.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(strip).toHaveAttribute("data-voice-strip", "listening");
  await expect(banner).toBeVisible();

  const top = await box(page, `[data-approval="${asking.address}"]`);
  const bottom = await box(page, "[data-voice-strip]");
  const screen = await box(page, `[data-terminal="${asking.address}"]`);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport");
  // No overlap: the banner ends above the strip, which ends at the screen's bottom edge.
  expect(top.y + top.height).toBeLessThanOrEqual(bottom.y);
  expect(top.y).toBeLessThan(screen.y + 24);
  expect(bottom.y + bottom.height).toBeGreaterThan(viewport.height - 80);
  expect(bottom.y + bottom.height).toBeLessThanOrEqual(viewport.height + 1);

  // Both still work: Yes on the card answers the agent with one key while dictation stays open.
  await banner.locator('[data-option="1"]').click();
  // The agent can already be idle while the card still awaits the reply to its final approval write.
  await test.step("Wait for the core to confirm this answer", () => settled.promise);
  await expect(banner).toContainText("from this device", { timeout: 10_000 });
  await expect.poll(asking.keys, { timeout: 10_000 }).toEqual(["1"]);
  await expect(strip).toHaveAttribute("data-voice-strip", "listening");
});
