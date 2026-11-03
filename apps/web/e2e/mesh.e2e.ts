import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { machineRow, STATE_BOUND_MS } from "./machine-switch.ts";

const group = (page: Page, id: string) => page.locator(`[data-mesh-group="${id}"]`);

async function openMesh(page: Page): Promise<void> {
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Mesh" })
    .or(page.getByRole("button", { name: "Mesh" }))
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Mesh", level: 2 }).first()).toBeVisible();
}

test("the mesh panel groups every machine of the host's status document", async ({ page }) => {
  await openMesh(page);
  await expect(group(page, "pending")).toContainText("ci-runner asks to join", { timeout: 20_000 });
  await expect(group(page, "online")).toContainText("studio");
  await expect(group(page, "online")).toContainText("build-box");
  await expect(group(page, "offline")).toContainText("laptop");
  await expect(group(page, "offline")).toContainText("tablet");
  await expect(group(page, "offline")).toContainText("doriface-host mesh revoke laptop");
  await expect(group(page, "revoked")).toContainText("kiosk");
  await expect(group(page, "revoked")).not.toContainText("spare");
  await expect(page.locator('[data-mesh-group^="removed-"]')).toContainText("spare");
  await expect(page.getByText("tablet joined the mesh")).toBeVisible();
  // build-box is connected both in the document and in this core's machine.list, so nothing disagrees.
  await expect(page.getByText("disagrees with machine.list")).toHaveCount(0);
});

test("approving a pending join writes the answer and shows it in place", async ({ page }) => {
  await openMesh(page);
  const pending = group(page, "pending");
  await pending.getByRole("button", { name: "Approve" }).click();
  await expect(pending).toContainText("Approved; studio admits it next", { timeout: 15_000 });
  await page.reload();
  await openMesh(page);
  await expect(group(page, "pending")).toContainText("Approved; studio admits it next", { timeout: 20_000 });
});
