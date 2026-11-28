// #2939: an AI agent's first connection waits for the owner on a host in no mesh too. That host publishes only its
// waiting joins (`doriface-joins`), and the owner answers them on the same card and in Settings > Machines.
import { MESH_APPROVAL_DOC, MESH_STATUS_DOC, SOLO_JOINS_DOC } from "@doriface/protocol";
import { getCoreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { resetMeshDocs } from "./mesh-reset.ts";

const NONCE = "c29sby1hZ2VudC1qb2lu";
const CODE = "482 913";

/** A host in no mesh with one agent waiting; `self` is not the e2e host's, so its own publisher leaves the document. */
function soloHostWithAgent(): void {
  setCoreDoc(MESH_STATUS_DOC, null);
  setCoreDoc(MESH_APPROVAL_DOC, {});
  setCoreDoc(SOLO_JOINS_DOC, {
    v: 1,
    self: "zwtofodlvf3djbujxpfsxjeixa",
    pending: [
      {
        nonce: NONCE,
        name: "claude",
        hostId: "ll24ek6y4pustmq275zjb7odpa",
        fingerprint: "0723 2115 F960 F2B0 9FDE 12AD B736 B333 02A1 51EB",
        expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
        kind: "agent",
        code: CODE,
        joinerConfirmed: true,
      },
    ],
  });
}

test.beforeEach(soloHostWithAgent);
test.afterEach(() => {
  setCoreDoc(SOLO_JOINS_DOC, null);
  resetMeshDocs({ open: false });
});

test("a solo host's agent request rises as the card over the workspace and is approved there", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(`[data-join-request="${NONCE}"]`);
  await expect(card.getByRole("heading", { name: "The agent claude wants to connect" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(card.getByLabel("Join code")).toHaveText(CODE);
  await card.getByRole("button", { name: "Approve" }).click();
  // The e2e host holds no such join, so it adds its outcome beside the answer; the answer is what the app wrote.
  await expect
    .poll(() => getCoreDoc(MESH_APPROVAL_DOC), { timeout: 20_000 })
    .toMatchObject({ approve: NONCE, code: CODE });
});

test("a solo host's agent request waits in Settings > Machines and is refused there", async ({ page }) => {
  await page.goto("/settings#machines");
  const waiting = page.locator('[data-mesh-group="pending"]');
  await expect(waiting).toContainText("claude", { timeout: 30_000 });
  await expect(waiting).toContainText('Approve "claude" (AI agent)?');
  await waiting.locator('[data-mesh-verdict="deny"]').click();
  // The e2e host holds no such join, so it adds its outcome beside the answer; the answer is what the app wrote.
  await expect.poll(() => getCoreDoc(MESH_APPROVAL_DOC), { timeout: 20_000 }).toMatchObject({ deny: NONCE });
});

test("the card leaves once the request is gone", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(`[data-join-request="${NONCE}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  setCoreDoc(SOLO_JOINS_DOC, null);
  await expect(card).toHaveCount(0, { timeout: 20_000 });
});
