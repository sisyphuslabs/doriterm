import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { reconnect, STATE_BOUND_MS, switchTo, OFFLINE_BOUND_MS, OFFLINE_TEST_TIMEOUT_MS } from "./machine-switch.ts";

test.describe("Settings, Machines", () => {
  test("lists this machine and the added one with their state, and says when and why one went offline", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Machines" }).click();
    await expect(page.getByRole("heading", { name: "Machines", level: 2 })).toBeVisible();
    const list = page.getByRole("list", { name: "Machines" });
    await expect(list.getByRole("listitem").filter({ hasText: "studio" })).toContainText("This machine", {
      timeout: 15_000,
    });
    const added = list.getByRole("listitem").filter({ hasText: MACHINE_NAME });
    await expect(added).toContainText("Connected", { timeout: STATE_BOUND_MS });
    await page.getByRole("button", { name: "Add a machine" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a machine" });
    await expect(dialog).toContainText("doriface-host pair");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/ssh target/)).toHaveCount(0);
    try {
      switchTo("drop");
      await expect(added).toContainText("Offline", { timeout: OFFLINE_BOUND_MS });
      await expect(added).toContainText(/Last seen (just now|\d+m ago)/);
      await expect(added).toContainText("isn't answering");
      await expect(added).not.toContainText(/cannot reach|sh -c/);
    } finally {
      reconnect();
    }
    await expect(added).toContainText("Connected", { timeout: STATE_BOUND_MS });
  });
});
