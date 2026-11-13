import { expect, test } from "@playwright/test";
import { phoneContext, routeOnlyRelay, savedMembership, enterInvite } from "./browser-mesh-page.ts";
import { startFakeRelayHost } from "./relay-route.ts";

test.use({ serviceWorkers: "block" });

test("Safari hands an invite to an empty app partition, compares both screens, then removes only its tab", async ({
  browser,
  baseURL,
  browserName,
}, info) => {
  // The Safari tab and the app partition each join through the relay, and the approval waits out up to two of the
  // host's 10 s status ticks (below). That alone can take 25 s, so the default 60 s left too little for the rest on a
  // loaded host (#2113).
  test.setTimeout(120_000);
  const host = await startFakeRelayHost({ terminal: true });
  const safari = await phoneContext(browser, baseURL, "tab");
  const app = await phoneContext(browser, baseURL, "app");
  try {
    const tab = await safari.newPage();
    await routeOnlyRelay(tab, host);
    await tab.goto((await host.meshOffer()).link);
    await tab.getByLabel("This browser's name").fill("safari-tab");
    await tab.getByRole("button", { name: "Join", exact: true }).click();
    await expect(tab.getByLabel("Join code")).toBeVisible();
    const first = await host.pendingJoin();
    await expect(tab.getByLabel("Join code")).toHaveText(first.code);
    await tab.getByRole("button", { name: "The codes match", exact: true }).click();
    await host.answerJoin(first.nonce, first.code, true);
    await expect(tab).toHaveURL(/\/settings#machines$/);
    await tab.goto("/settings");
    await tab.getByRole("button", { name: "Join in the home-screen app", exact: true }).click();
    await expect(tab.getByRole("link", { name: "Open invite", exact: true })).toBeVisible();
    let invite: string;
    if (browserName === "chromium") {
      await tab.getByRole("button", { name: "Copy invite", exact: true }).click();
      invite = await tab.evaluate(() => navigator.clipboard.readText());
    } else {
      const href = await tab.getByRole("link", { name: "Open invite", exact: true }).getAttribute("href");
      if (href === null) throw new Error("the tab did not expose its invite");
      invite = href;
    }
    expect(invite).toContain("/pair#");
    await tab.screenshot({ path: info.outputPath("safari-handoff.png"), fullPage: true });
    let installed = await app.newPage();
    await routeOnlyRelay(installed, host);
    await installed.goto("/");
    await expect(installed.getByRole("button", { name: "Paste invite", exact: true })).toBeVisible();
    expect(await savedMembership(installed)).toBeNull();
    await enterInvite(installed, invite, browserName);
    await installed.getByLabel("This browser's name").fill("safari-app");
    await installed.getByRole("button", { name: "Join", exact: true }).click();
    await expect(installed.getByLabel("Join code")).toBeVisible();
    const code = await installed.getByLabel("Join code").textContent();
    if (code === null) throw new Error("the joining app did not show its code");
    await installed.close();
    // The host publishes status every 10 s; the reader can be one more 10 s tick behind it.
    await expect(tab.getByLabel("Join code")).toHaveText(code, { timeout: 25_000 });
    await tab.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(tab.getByText("Waiting for safari-app to confirm the code", { exact: true })).toBeVisible();
    installed = await app.newPage();
    await routeOnlyRelay(installed, host);
    await installed.goto("/join");
    await expect(installed.getByLabel("Join code")).toHaveText(code);
    expect(await savedMembership(installed)).toBeNull();
    await installed.getByRole("button", { name: "The codes match", exact: true }).click();
    await expect(installed).toHaveURL(/\/settings#machines$/);
    const tabKey: unknown = Reflect.get(Object(await savedMembership(tab)), "signPub");
    const appKey: unknown = Reflect.get(Object(await savedMembership(installed)), "signPub");
    expect(typeof tabKey).toBe("string");
    expect(typeof appKey).toBe("string");
    expect(appKey).not.toBe(tabKey);
    await expect(
      tab.getByText("The home-screen app joined. Remove this tab from the mesh?", { exact: true }),
    ).toBeVisible();
    await expect(tab.getByLabel("Join code")).toHaveCount(0);
    await expect(tab.getByRole("button", { name: "Keep", exact: true })).toBeVisible();
    await tab.screenshot({ path: info.outputPath("safari-cleanup.png"), fullPage: true });
    await tab.getByRole("button", { name: "Remove", exact: true }).click();
    await tab.getByRole("button", { name: "Leave this mesh", exact: true }).click();
    await expect(tab).toHaveURL(/\/join$/);
    expect(await savedMembership(tab)).toBeNull();
    expect(await savedMembership(installed)).not.toBeNull();
    await installed.reload();
    await expect(installed.getByRole("list", { name: "Machines", exact: true })).toContainText("Online");
    await installed.getByRole("button", { name: "Open", exact: true }).click();
    await expect(installed.getByText("existing", { exact: true }).first()).toBeVisible();
  } finally {
    await safari.close();
    await app.close();
    await host.stop();
  }
});

test("an unjoined Safari tab hands the unspent invite to the app and stays a stranger", async ({
  browser,
  baseURL,
  browserName,
}) => {
  const host = await startFakeRelayHost({ terminal: true });
  const safari = await phoneContext(browser, baseURL, "tab");
  const app = await phoneContext(browser, baseURL, "app");
  try {
    const offer = await host.meshOffer();
    const tab = await safari.newPage();
    await routeOnlyRelay(tab, host);
    await tab.goto(offer.link);
    await tab.getByRole("button", { name: "Join in the home-screen app", exact: true }).click();
    await expect(tab.getByText("Invite copied", { exact: true })).toBeVisible();
    expect(await savedMembership(tab)).toBeNull();
    const link = browserName === "chromium" ? await tab.evaluate(() => navigator.clipboard.readText()) : offer.link;
    const installed = await app.newPage();
    await routeOnlyRelay(installed, host);
    await installed.goto("/");
    await enterInvite(installed, link, browserName);
    await installed.getByLabel("This browser's name").fill("installed-browser");
    await installed.getByRole("button", { name: "Join", exact: true }).click();
    await expect(installed.getByLabel("Join code")).toBeVisible();
    const pending = await host.pendingJoin();
    await expect(installed.getByLabel("Join code")).toHaveText(pending.code);
    await host.answerJoin(pending.nonce, pending.code, true);
    await installed.getByRole("button", { name: "The codes match", exact: true }).click();
    await expect(installed).toHaveURL(/\/settings#machines$/);
    expect(await savedMembership(tab)).toBeNull();
    expect(await savedMembership(installed)).not.toBeNull();
    await expect(installed.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await installed.getByRole("button", { name: "Open", exact: true }).click();
    await expect(installed.getByText("existing", { exact: true }).first()).toBeVisible();
  } finally {
    await safari.close();
    await app.close();
    await host.stop();
  }
});

test("an invitation substituted between the tab and app is rejected without admitting either browser", async ({
  browser,
  baseURL,
}) => {
  const intended = await startFakeRelayHost();
  const substitute = await startFakeRelayHost();
  const safari = await phoneContext(browser, baseURL, "tab");
  const app = await phoneContext(browser, baseURL, "app");
  try {
    const original = await intended.meshOffer();
    const replacement = await substitute.meshOffer();
    const originalId = new URLSearchParams(new URL(original.link).hash.slice(1)).get("h");
    const replacementId = new URLSearchParams(new URL(replacement.link).hash.slice(1)).get("h");
    expect(replacementId).not.toBeNull();
    expect(originalId).not.toBe(replacementId);
    const tab = await safari.newPage();
    await routeOnlyRelay(tab, intended);
    await tab.goto(original.link);
    await tab.getByRole("button", { name: "Join in the home-screen app", exact: true }).click();
    const installed = await app.newPage();
    await routeOnlyRelay(installed, substitute);
    await installed.goto("/");
    await installed.getByLabel("Invite link or code").fill(replacement.link);
    await installed.getByRole("button", { name: "Continue", exact: true }).click();
    await installed.getByRole("button", { name: "Join", exact: true }).click();
    await expect(installed.getByLabel("Join code")).toBeVisible();
    await expect(tab.getByLabel("Join code")).toHaveCount(0);
    await installed.getByRole("button", { name: "The codes differ", exact: true }).click();
    await expect(installed.getByText("Not joined", { exact: true })).toBeVisible();
    expect(await savedMembership(tab)).toBeNull();
    expect(await savedMembership(installed)).toBeNull();
    // A refused first join leaves the inviter in no mesh at all, not a mesh of itself (#1635, #1428).
    expect(await substitute.memberIds()).toEqual([]);
  } finally {
    await safari.close();
    await app.close();
    await intended.stop();
    await substitute.stop();
  }
});

test("an installed app refuses an automatic machine invite without sending a client card", async ({
  browser,
  baseURL,
}) => {
  const host = await startFakeRelayHost();
  const app = await phoneContext(browser, baseURL, "app");
  try {
    const offer = await host.meshOffer(true);
    const page = await app.newPage();
    await routeOnlyRelay(page, host);
    await page.goto(offer.link);
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByText("Not joined", { exact: true })).toBeVisible();
    await expect(page.getByText(/This machine needs an update, or this is an Add a machine invite/)).toBeVisible();
    await expect(page.getByText(/needs an update/)).toBeVisible();
    expect(await savedMembership(page)).toBeNull();
    // A refused first join leaves the host in no mesh at all, not a mesh of itself (#1635, #1428).
    expect(await host.memberIds()).toEqual([]);
  } finally {
    await app.close();
    await host.stop();
  }
});
