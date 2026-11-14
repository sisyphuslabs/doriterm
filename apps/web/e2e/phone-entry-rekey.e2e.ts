// A phone history entry made through another core is read back keyed for the core the page goes through now (#2588).
import { devices } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

test("Back to an entry made through another core re-keys its space and terminal in place, and stamps the core now", async ({
  page,
}) => {
  await page.goto("/?v=spaces");
  await expect(page.getByRole("heading", { name: "Spaces" }).first()).toBeVisible({ timeout: 20_000 });
  // Every replace the router makes is recorded, so a re-key is seen even if a later effect moves on from it.
  await page.evaluate(() => {
    const replaced: string[] = [];
    Reflect.set(window, "replaced", replaced);
    const replace = history.replaceState.bind(history);
    history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => {
      replaced.push(String(url ?? ""));
      replace(state, unused, url);
    };
    // An entry this device made while the page went through another core, then one on top of it.
    const index = Number(Reflect.get(history.state ?? {}, "__TSR_index") ?? 0);
    history.pushState(
      { ...history.state, phoneCore: "other-core", __TSR_index: index + 1 },
      "",
      "/?s=space%3As9&t=local%3At9",
    );
    history.pushState({ ...history.state, __TSR_index: index + 2 }, "", "/?v=spaces");
  });
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => (Reflect.get(window, "replaced") as string[]).join(" ")))
    .toContain("t=id%3Aother-core%2Ft9");
  const replaced = await page.evaluate(() => (Reflect.get(window, "replaced") as string[]).join(" "));
  expect(replaced).toContain("s=space%3Aother-core%2Fs9");
});
