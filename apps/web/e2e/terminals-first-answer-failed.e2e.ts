import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const FIRST = ["terminal.list", "events.subscribe"] as const;

for (const [width, height] of [
  [390, 844],
  [1280, 720],
] as const) {
  test(`at ${width}, a first terminal answer that failed says so with Try again, which loads the list (#819)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const link = await routeHcSocket(page);
    const release = link.hold(...FIRST);
    await page.goto("/");
    // Both first requests are on their way: answer each with an RPC error.
    await expect
      .poll(() => FIRST.every((method) => link.sent().some((frame) => frame.includes(`"method":"${method}"`))))
      .toBe(true);
    release(true);

    const notice = page.getByRole("alert").filter({ hasText: "Could not load the agents" });
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Loading agents…")).toHaveCount(0);

    link.hold();
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect(notice).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Agents" })
        .or(page.getByRole("heading", { name: "Agents" }))
        .first(),
    ).toBeVisible({
      timeout: 15_000,
    });
  });
}
