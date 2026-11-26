import { expect, test, type Page } from "@playwright/test";
import { browserMeshFixture } from "./browser-mesh-fixture.ts";
import { routeOnlyRelay } from "./browser-mesh-page.ts";
import { startFakeRelayHost } from "./relay-route.ts";
import { seedTwoMeshes, stored, storedMeshes } from "./two-meshes-page.ts";

test.use({ serviceWorkers: "block" });

const meshes = (page: Page) => page.getByRole("list", { name: "Meshes", exact: true });

const offline = (page: Page) =>
  page.routeWebSocket(/.*/, (socket) => socket.close({ code: 4404, reason: "fixture offline" }));

test("a mesh forgotten in one tab is dropped by the other tab too, with both of its keys", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  try {
    const first = browserMeshFixture();
    const second = browserMeshFixture();
    const leaving = await context.newPage();
    await offline(leaving);
    await leaving.goto("/");
    await seedTwoMeshes(leaving, first, second);
    const watching = await context.newPage();
    await offline(watching);
    await watching.goto("/settings");
    await leaving.goto("/settings");
    await expect(meshes(watching).getByRole("listitem")).toHaveCount(2);
    await meshes(leaving)
      .getByRole("listitem")
      .filter({ hasText: second.membership.meshId })
      .getByRole("button")
      .click();
    await leaving.getByRole("button", { name: "Leave this mesh", exact: true }).click();
    await leaving.getByRole("dialog").getByRole("button", { name: "Leave this mesh", exact: true }).click();
    await leaving.getByRole("button", { name: "Forget this mesh here", exact: true }).click();

    await expect(meshes(watching)).toHaveCount(0);
    await expect(watching.getByText(`Member of ${first.membership.meshId} · 0 machines online`)).toBeVisible();
    await expect.poll(() => storedMeshes(watching)).toEqual([first.membership.meshId]);
    const keys = ["mesh-sign-key", "device-key", "mesh-sign-key.probe", "device-key.probe"];
    const left = await Promise.all(keys.map((key) => stored(watching, `mesh-identity/second/${key}`)));
    expect(left).toEqual([null, null, null, null]);
  } finally {
    await context.close();
  }
});

test("two tabs joining two meshes at once get two identities, one each", async ({ browser, baseURL }) => {
  const hosts = await Promise.all([
    startFakeRelayHost({ terminal: true, machine: true }),
    startFakeRelayHost({ terminal: true, machine: true }),
  ]);
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), serviceWorkers: "block" });
  try {
    const tabs = await Promise.all(hosts.map(() => context.newPage()));
    await Promise.all(tabs.map((tab, index) => routeOnlyRelay(tab, hosts[index] ?? hosts[0])));
    const offers = await Promise.all(hosts.map((host) => host.meshOffer()));
    await Promise.all(tabs.map((tab, index) => tab.goto(offers[index]?.link ?? "/")));
    await Promise.all(tabs.map((tab, index) => tab.getByLabel("This browser's name").fill(`tab-${index + 1}`)));
    await Promise.all(tabs.map((tab) => tab.getByRole("button", { name: "Join", exact: true }).click()));
    const pending = await Promise.all(hosts.map((host) => host.pendingJoin()));
    await Promise.all(
      tabs.map((tab, index) => expect(tab.getByLabel("Join code")).toHaveText(pending[index]?.code ?? "")),
    );
    await Promise.all(tabs.map((tab) => tab.getByRole("button", { name: "The codes match", exact: true }).click()));
    await Promise.all(
      hosts.map((host, index) => host.answerJoin(pending[index]?.nonce ?? "", pending[index]?.code ?? "", true)),
    );
    await Promise.all(tabs.map((tab) => expect(tab).toHaveURL(/\/settings#machines$/)));

    const record = await stored(tabs[0] ?? (await context.newPage()), "mesh-memberships");
    const held: unknown = Reflect.get(Object(record), "memberships");
    if (!Array.isArray(held)) throw new Error("no memberships were stored");
    const field = (key: string) => held.map((membership: unknown) => Reflect.get(Object(membership), key));
    expect(held).toHaveLength(2);
    expect(new Set(field("keySlot")).size).toBe(2);
    expect(field("keySlot")).toContain("");
    expect(new Set(field("signPub")).size).toBe(2);
    expect(new Set(field("meshId")).size).toBe(2);
    expect(Reflect.get(Object(record), "slots")).toEqual([]);
  } finally {
    await context.close();
    await Promise.all(hosts.map((host) => host.stop()));
  }
});
