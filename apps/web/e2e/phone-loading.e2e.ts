import { devices } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** The live terminals the e2e core lists, this machine's and the added machine's. */
function liveAddresses(): string[] {
  const listed: unknown = JSON.parse(hcOn("host", ["ls", "--json"]));
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) return [];
  return terminals.map((terminal: unknown) =>
    typeof terminal === "object" && terminal !== null ? String(Reflect.get(terminal, "address")) : "",
  );
}

test("while the first list is unanswered the phone says it is loading, and the empty state waits for the answer", async ({
  page,
}) => {
  // Earlier specs share this core and may leave shells running; the empty state this ends on needs none.
  for (const address of liveAddresses()) hcOn("host", ["kill", address]);
  await expect.poll(liveAddresses, { timeout: 15_000 }).toEqual([]);

  const socket = await routeHcSocket(page);
  const release = socket.hold("terminal.list", "events.subscribe");
  await page.goto("/");

  const loading = page.getByRole("status", { name: "Loading agents" });
  await expect(loading).toBeVisible({ timeout: 20_000 });
  // The quiet busy state draws itself once the wait outlasts its delay, so this is the state on screen, not a flash.
  await expect(loading).toHaveCSS("opacity", "1");
  await expect(page.getByText("No terminals yet")).toHaveCount(0);

  release();
  await expect(page.getByRole("status").filter({ hasText: "No terminals yet" })).toBeVisible({ timeout: 20_000 });
  await expect(loading).toHaveCount(0);
});
