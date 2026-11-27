import { devices } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** The live terminals the e2e core lists, this machine's and the added machine's. */
function liveAddresses(): string[] {
  const listed: unknown = JSON.parse(hcOn("host", ["ls", "--json"]));
  const terminals = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : undefined;
  if (!Array.isArray(terminals)) throw new Error("hc ls printed no terminal list");
  return terminals.map((terminal: unknown) =>
    typeof terminal === "object" && terminal !== null ? String(Reflect.get(terminal, "address")) : "",
  );
}

test("with no terminals the phone says so and offers a new terminal and adding a machine", async ({ page }) => {
  // Earlier specs share this core and may leave shells running. One pass ends each one it lists, so the cleanup takes
  // the same time however many there are, and the core must then list none.
  const left = liveAddresses();
  for (const address of left) hcOn("host", ["kill", address]);
  await expect.poll(liveAddresses, { timeout: 15_000, message: `${left.length} ended` }).toEqual([]);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  const empty = page.getByRole("status").filter({ hasText: "No terminals yet" });
  await expect(empty).toBeVisible({ timeout: 15_000 });
  await expect(empty.getByRole("button", { name: "Connect a device" })).toBeVisible();
  await empty.getByRole("button", { name: "New terminal" }).click();
  await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 15_000 });

  // The terminal it opened is the core's only one; ending it leaves the core as empty as the spec found it.
  await expect.poll(liveAddresses, { timeout: 15_000 }).toHaveLength(1);
  const [own = ""] = liveAddresses();
  endAgent("host", own);
  expect(liveAddresses()).toEqual([]);
});
