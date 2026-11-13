import { MESH_APPROVAL_DOC } from "@doriface/protocol";
import type { Page } from "@playwright/test";
import { setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { machineRow, STATE_BOUND_MS } from "./machine-switch.ts";
import { resetMeshDocs } from "./mesh-reset.ts";

/** The fixture's expired join; an answer to it leaves ci-runner's open. */
const OLD_RUNNER_NONCE = "ZXhwaXJlZCBqb2lu";

const group = (page: Page, id: string) => page.locator(`[data-mesh-group="${id}"]`);

test.beforeEach(() => resetMeshDocs());

async function openMesh(page: Page): Promise<void> {
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Machines" })
    .or(page.getByRole("button", { name: "Machines" }))
    .first()
    .click();
  await expect(page.locator("[data-mesh-group]").first()).toBeVisible({ timeout: 20_000 });
}

test("the mesh panel groups every machine of the host's status document", async ({ page }) => {
  await openMesh(page);
  await expect(group(page, "pending").locator('[data-mesh-answer="open"]')).toHaveCount(1);
  await expect(group(page, "pending")).toContainText("ci-runner");
  await expect(group(page, "online")).toContainText("studio");
  await expect(group(page, "online")).toContainText("build-box");
  await expect(group(page, "offline")).toContainText("laptop");
  await expect(group(page, "offline")).toContainText("tablet");
  await expect(group(page, "offline")).toContainText("doriface-host mesh revoke laptop");
  // A revoked key is gone for the person: no group of machine rows, one line with the count (spare shows under its removal).
  await expect(group(page, "revoked")).toHaveCount(0);
  await expect(page.locator("[data-mesh-revoked]")).toHaveText(/^1 removed machine:/);
  await expect(page.locator('[data-mesh-group^="removed-"]')).toContainText("spare");
  await expect(page.locator('[data-mesh-banner="notice"]')).toHaveCount(1);
  await expect(page.locator('[data-mesh-banner="notice"]')).toContainText("tablet");
  // build-box is connected both in the document and in this core's machine.list, so nothing disagrees.
  await expect(page.locator('[data-mesh-banner="disagreement"]')).toHaveCount(0);
});

test("a copy the clipboard refuses says so beside the command", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
  });
  await openMesh(page);
  const command = group(page, "offline").locator("[data-copy-state]").first();
  await expect(command).toHaveAttribute("data-copy-state", "idle", { timeout: 20_000 });
  await expect(command.getByRole("status")).toBeAttached();
  await command.getByRole("button").click();
  await expect(command).toHaveAttribute("data-copy-state", "failed");
  await expect(command.getByRole("status")).toBeVisible();
});

test("an expired join offers no answer and does not wait for approval", async ({ page }) => {
  await openMesh(page);
  const expired = group(page, "expired");
  await expect(expired.locator('[data-mesh-answer="expired"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(expired.locator("button")).toHaveCount(0);
  await expect(group(page, "pending").locator("[data-mesh-answer]")).toHaveCount(1);
  await expect(group(page, "pending").locator('[data-mesh-answer="open"] button')).toHaveCount(2);
});

test("approving a pending join writes the answer and shows it in place", async ({ page }) => {
  await openMesh(page);
  const pending = group(page, "pending");
  await expect(pending.getByLabel("Join code")).toHaveText("123 456");
  await pending.locator('[data-mesh-answer="open"] [data-mesh-verdict="approve"]').click();
  await expect(pending.locator('[data-mesh-answer="approve"]')).toHaveCount(1, { timeout: 15_000 });
  await page.reload();
  await openMesh(page);
  await expect(group(page, "pending").locator('[data-mesh-answer="approve"]')).toHaveCount(1, { timeout: 20_000 });
});

test("a join whose answer another writer replaced takes an answer again", async ({ page }) => {
  setCoreDoc(MESH_APPROVAL_DOC, { deny: OLD_RUNNER_NONCE });
  await openMesh(page);
  const pending = group(page, "pending");
  await expect(pending.getByLabel("Join code")).toHaveText("123 456");
  await pending.locator('[data-mesh-answer="open"] [data-mesh-verdict="approve"]').click();
  await expect(pending.locator('[data-mesh-answer="approve"]')).toHaveCount(1, { timeout: 15_000 });
  setCoreDoc(MESH_APPROVAL_DOC, { deny: OLD_RUNNER_NONCE });
  const open = pending.locator('[data-mesh-answer="open"]');
  await expect(open).toHaveCount(1, { timeout: STATE_BOUND_MS });
  await expect(open.locator("button:enabled")).toHaveCount(2);
  await expect(open.locator('[aria-busy="true"]')).toHaveCount(0);
});
