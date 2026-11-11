// #545: while the host cannot be reached, the connection notice says so once; the sidebar shows no raw error of its own
// beside it, and is back to normal when the host answers again.
import { getCoreDoc } from "./core-doc.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";

test.use({ serviceWorkers: "block" });

test("a host that cannot be reached leaves the sidebar without a raw error beside the connection notice", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const spaces = page.getByRole("region", { name: "Spaces" });
  await expect(spaces).toBeVisible();

  await link.drop(true);
  await expect(page.getByRole("contentinfo").getByText(/Reconnecting/)).toBeVisible({ timeout: 20_000 });
  // The sidebar reads the machines again when the page is shown; that read meets the closed link.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("contentinfo").getByText(/Reconnecting/)).toBeVisible();
  // The sidebar keeps its spaces and says nothing that competes with the notice, least of all the raw cause.
  await expect(page.getByText("connection is closed")).toHaveCount(0);
  await expect(spaces.getByText("Could not list the machines")).toHaveCount(0);

  link.restore();
  await expect(page.getByRole("contentinfo").getByText(/Reconnecting/)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText("Could not list the machines")).toHaveCount(0);
});

// #698: a layout write still in flight when the link drops (a new tab's, slow under load) is not saved, and the page says
// so in plain words: neither the write's cause nor the re-read that meets the closed link reaches the screen raw.
test("a layout write the drop cuts off says it was not saved, without the raw cause", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const first = await openNewTerminal(page);
  const address = await first.getAttribute("data-terminal");
  // The first tab's own layout write has to reach the host before the hold: a terminal shows its prompt before its tab
  // is saved, and a hold that parks that write keeps the second tab's write queued behind it, so it never shows (#1539).
  await expect
    .poll(() => JSON.stringify(getCoreDoc(LAYOUT_DOC)).includes(`"terminal":"${String(address)}"`))
    .toBe(true);
  const before = link.sent().length;
  link.hold("doc.set");
  await openNewTerminal(page);
  await expect
    .poll(() =>
      link
        .sent()
        .slice(before)
        .some((frame) => frame.includes('"method":"doc.set"')),
    )
    .toBe(true);

  await link.drop(true);
  await expect(page.getByRole("contentinfo").getByText(/Reconnecting/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("The layout was not saved")).toBeVisible();
  await expect(page.getByText(/Reconnecting to .+; make the change again once it is back\./)).toBeVisible();
  await expect(page.getByText("connection is closed")).toHaveCount(0);

  link.restore();
  await expect(page.getByRole("contentinfo").getByText(/Reconnecting/)).toHaveCount(0, { timeout: 30_000 });
});
