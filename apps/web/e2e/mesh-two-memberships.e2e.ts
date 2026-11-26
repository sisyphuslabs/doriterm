import { expect, test, type Page } from "@playwright/test";
import { browserMeshFixture } from "./browser-mesh-fixture.ts";
import { seedTwoMeshes, stored, storedMeshes } from "./two-meshes-page.ts";

const machinesTab = (page: Page) =>
  page
    .getByRole("tab", { name: "Machines", exact: true })
    .or(page.getByRole("button", { name: "Machines", exact: true }))
    .first();

test("a browser in two meshes names each machine's mesh, and forgetting one keeps the other", async ({ page }) => {
  const first = browserMeshFixture();
  const second = browserMeshFixture();
  await page.routeWebSocket(/.*/, (socket) => socket.close({ code: 4404, reason: "fixture offline" }));
  await page.goto("/");
  await seedTwoMeshes(page, first, second);
  await page.goto("/settings");

  const meshes = page.getByRole("list", { name: "Meshes", exact: true });
  await expect(meshes.getByRole("listitem")).toHaveCount(2);
  await expect(meshes).toContainText(`Mesh ${first.membership.meshId}`);
  await expect(meshes).toContainText(`Mesh ${second.membership.meshId}`);
  await expect(meshes.getByText("In view", { exact: true })).toHaveCount(1);
  await expect(page.getByText(`Member of ${first.membership.meshId} · 0 machines online`)).toBeVisible();

  await machinesTab(page).click();
  const machines = page.getByRole("list", { name: "Machines", exact: true });
  await expect(machines.getByRole("listitem")).toHaveCount(4);
  await expect(machines.getByText(`Mesh ${first.membership.meshId}`, { exact: true })).toHaveCount(2);
  await expect(machines.getByText(`Mesh ${second.membership.meshId}`, { exact: true })).toHaveCount(2);

  await page.goto("/settings");
  await meshes.getByRole("listitem").filter({ hasText: second.membership.meshId }).getByRole("button").click();
  await expect(page.getByText(`Member of ${second.membership.meshId} · 0 machines online`)).toBeVisible();
  await page.getByRole("button", { name: "Leave this mesh", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave this mesh", exact: true }).click();
  await page.getByRole("button", { name: "Forget this mesh here", exact: true }).click();

  await expect(page.getByText(`Member of ${first.membership.meshId} · 0 machines online`)).toBeVisible();
  await expect(page.getByRole("list", { name: "Meshes", exact: true })).toHaveCount(0);
  await expect.poll(() => storedMeshes(page)).toEqual([first.membership.meshId]);
  const keys = ["mesh-sign-key", "device-key", "mesh-sign-key.probe", "device-key.probe"];
  const left = await Promise.all(keys.map((key) => stored(page, `mesh-identity/second/${key}`)));
  expect(left).toEqual([null, null, null, null]);
  expect(await stored(page, "mesh-sign-key")).not.toBeNull();
  expect(await stored(page, "device-key")).not.toBeNull();
});
