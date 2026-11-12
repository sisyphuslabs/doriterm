// #2003 (DORITERM-16): a terminal on an added machine resized while that machine's line is down has its grid's pty size
// once the line is back, as one resized while the page's own link is down has (terminal-pty-size.e2e.ts).
import { gridSize } from "./core-size.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn, machineRow, newOn, reconnect, switchTo } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** The pty size the machine's own core holds for its terminal `id`, as "rows cols", read with hc so nothing is typed. */
function machineSize(id: string): string {
  const terminal: unknown = JSON.parse(hcOn("machine", ["get", id, "--json"]));
  return `${String(Reflect.get(Object(terminal), "rows"))} ${String(Reflect.get(Object(terminal), "cols"))}`;
}

test.afterEach(() => reconnect());

test("a terminal on an added machine resized while its line is down has its grid's pty size once the line is back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 20_000 });
  await newOn(page).click({ force: true });
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toHaveAttribute("data-terminal", new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`), {
    timeout: 15_000,
  });
  const id = ((await terminal.getAttribute("data-terminal")) ?? "").slice(MACHINE_NAME.length + 1);
  await expect.poll(async () => machineSize(id) === (await gridSize(terminal)), { timeout: 15_000 }).toBe(true);

  switchTo("drop");
  const away = page.getByRole("status").filter({ hasText: `Reconnecting to ${MACHINE_NAME}.` });
  await expect(away).toBeVisible({ timeout: 15_000 });
  const before = await gridSize(terminal);
  await page.setViewportSize({ width: 900, height: 600 });
  await expect.poll(() => gridSize(terminal)).not.toBe(before);

  reconnect();
  await expect(away).toBeHidden({ timeout: 30_000 });
  // Read from the machine's core, so nothing typed can make this viewer active and apply the size for it.
  await expect.poll(() => machineSize(id), { timeout: 10_000 }).toBe(await gridSize(terminal));
});
