import { MESH_APPROVAL_DOC, MESH_STATUS_DOC, parseMeshStatus } from "@doriface/protocol";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { getCoreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow, STATE_BOUND_MS } from "./machine-switch.ts";
import { resetMeshDocs } from "./mesh-reset.ts";

/** The fixture's expired join; an answer to it leaves ci-runner's open. */
const OLD_RUNNER_NONCE = "ZXhwaXJlZCBqb2lu";
/** ci-runner's open join (the host fixture's pending join). */
const RUNNER_NONCE = "dGhlIGpvaW5lcidzIG5vbmNl";
const REFUSAL = "the approval code does not match this join";
/** A join the added machine holds, not this core. */
const HELD_NONCE = "aGVsZCBlbHNld2hlcmU";
/** Prints the fixture status document as of now; the fixture is Bun-only and specs run under Node (mesh-reset.ts). */
const MESH_DOC_SCRIPT = join(import.meta.dirname, "mesh-doc.ts");

const group = (page: Page, id: string) => page.locator(`[data-mesh-group="${id}"]`);

test.beforeEach(() => resetMeshDocs());
test.afterEach(() => resetMeshDocs({ open: false }));

// The trust step wherever the owner is looking (#2939): the waiting join's card over the workspace, answered in place.
for (const [width, size] of [
  ["1440", { width: 1440, height: 900 }],
  ["390", { width: 390, height: 844 }],
] as const) {
  test(`the waiting join's card rises over the workspace at ${width} and answers there (#2939)`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    const card = page.locator(`[data-join-request="${RUNNER_NONCE}"]`);
    await expect(card.getByRole("heading", { name: "ci-runner wants to join" })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByLabel("Join code")).toHaveText("123 456");
    await card.locator('[data-mesh-answer="open"] [data-mesh-verdict="approve"]').click();
    await expect
      .poll(() => getCoreDoc(MESH_APPROVAL_DOC), { timeout: 15_000 })
      .toMatchObject({ approve: RUNNER_NONCE });
    // The e2e host holds no such join, so it says so, and the card says what it said.
    await expect(card.locator('[data-mesh-answer="gone"]')).toHaveCount(1, { timeout: 15_000 });
  });
}

test("the card gives focus back to where it came from when it leaves (#2944 review)", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(`[data-join-request="${RUNNER_NONCE}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  const before = page.getByRole("button", { name: "New terminal" }).first();
  await before.focus();
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toHaveCount(0);
  await expect(before).toBeFocused();
});

test("Not now hides the card here while the join keeps waiting in Settings (#2939)", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(`[data-join-request="${RUNNER_NONCE}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toHaveCount(0);
  await openMesh(page);
  await expect(group(page, "pending").locator('[data-mesh-answer="open"]')).toHaveCount(1);
});

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
  await expect(page.locator("[data-mesh-revoked]")).toHaveText("1 removed machine");
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

// The fixture's ci-runner join is in the status document only: the e2e host holds no such join, and says so.
test("approving a join the host does not hold says so, instead of waiting for a confirmation (#2936)", async ({
  page,
}) => {
  await openMesh(page);
  const pending = group(page, "pending");
  await expect(pending.getByLabel("Join code")).toHaveText("123 456");
  await pending.locator('[data-mesh-answer="open"] [data-mesh-verdict="approve"]').click();
  await expect(pending.locator('[data-mesh-answer="gone"]')).toHaveCount(1, { timeout: 15_000 });
  expect(getCoreDoc(MESH_APPROVAL_DOC)).toMatchObject({ decided: false });
  await expect(pending.locator('[data-mesh-answer="approve"]')).toHaveCount(0);
  await page.reload();
  await openMesh(page);
  await expect(group(page, "pending").locator('[data-mesh-answer="gone"]')).toHaveCount(1, { timeout: 20_000 });
});

// The host's verdict as another client finds it: a document that already carries `decided` or `error` is not answered
// again by the host, so each case shows the approver exactly that verdict (#2936).
for (const [verdict, doc, shown] of [
  ["taken approve", { approve: RUNNER_NONCE, code: "123 456", decided: true }, "approve"],
  ["taken deny", { deny: RUNNER_NONCE, decided: true }, "deny"],
  ["refused", { approve: RUNNER_NONCE, code: "654 321", error: REFUSAL }, "open"],
] as const) {
  test(`the approver sees the host's ${verdict} answer (#2936)`, async ({ page }) => {
    setCoreDoc(MESH_APPROVAL_DOC, doc);
    await openMesh(page);
    const pending = group(page, "pending");
    await expect(pending.locator(`[data-mesh-answer="${shown}"]`)).toHaveCount(1, { timeout: 15_000 });
    if (shown === "open") {
      await expect(pending.getByText(REFUSAL, { exact: false })).toBeVisible();
      await expect(pending.locator('[data-mesh-answer="open"] button:enabled')).toHaveCount(2);
    }
  });
}

// A join invited on another machine is held and published only there (#2939): the app attached to this core lists it
// through that machine and answers it in that machine's approval document, where its host reads it.
test("a join waiting on another machine is listed through it and answered there (#2939)", async ({ page }) => {
  const status = parseMeshStatus(JSON.parse(execFileSync("bun", [MESH_DOC_SCRIPT, "open"], { encoding: "utf8" })));
  const open = status?.pending[0];
  if (status === undefined || open === undefined) throw new Error("the mesh fixture has no pending join");
  const held = { ...open, nonce: HELD_NONCE, name: "qa-phone", kind: "client" };
  setCoreDoc(MESH_STATUS_DOC, { ...status, pending: [held] }, MACHINE_NAME);
  setCoreDoc(MESH_APPROVAL_DOC, {}, MACHINE_NAME);
  try {
    await openMesh(page);
    const pending = group(page, "pending");
    const row = pending.locator("[data-setting-row]").filter({ hasText: "qa-phone" });
    await expect(row).toContainText(`through ${MACHINE_NAME}`, { timeout: 20_000 });
    await row.locator('[data-mesh-answer="open"] [data-mesh-verdict="approve"]').click();
    await expect
      .poll(() => getCoreDoc(MESH_APPROVAL_DOC, MACHINE_NAME), { timeout: 15_000 })
      .toMatchObject({
        approve: HELD_NONCE,
        code: "123 456",
      });
    expect(getCoreDoc(MESH_APPROVAL_DOC)).not.toMatchObject({ approve: HELD_NONCE });
  } finally {
    setCoreDoc(MESH_STATUS_DOC, null, MACHINE_NAME);
    setCoreDoc(MESH_APPROVAL_DOC, null, MACHINE_NAME);
  }
});

test("a join whose answer another writer replaced takes an answer again", async ({ page }) => {
  setCoreDoc(MESH_APPROVAL_DOC, { deny: OLD_RUNNER_NONCE });
  await openMesh(page);
  const pending = group(page, "pending");
  await expect(pending.getByLabel("Join code")).toHaveText("123 456");
  await pending.locator('[data-mesh-answer="open"] [data-mesh-verdict="approve"]').click();
  await expect(pending.locator('[data-mesh-answer="gone"]')).toHaveCount(1, { timeout: 15_000 });
  setCoreDoc(MESH_APPROVAL_DOC, { deny: OLD_RUNNER_NONCE });
  const open = pending.locator('[data-mesh-answer="open"]');
  await expect(open).toHaveCount(1, { timeout: STATE_BOUND_MS });
  await expect(open.locator("button:enabled")).toHaveCount(2);
  await expect(open.locator('[aria-busy="true"]')).toHaveCount(0);
});
