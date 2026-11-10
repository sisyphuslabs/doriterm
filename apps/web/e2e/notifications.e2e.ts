import { agentRow } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { askHost, deliverPush, heldSubscriptions, serviceWorker, subscribedKey, tapNotification } from "./push.ts";
import { finishingAgent, openSettings, press, pushButton, pushState, pushSuite, turnOn } from "./push-suite.ts";

const suite = pushSuite();

test("Turn on is the only thing that asks; the host then holds the subscription, and Turn off removes it", async ({
  page,
}) => {
  const service = suite.service();
  await openSettings(page);
  await expect(pushState(page)).toHaveAttribute("data-push-state", "off");
  expect(await page.evaluate(() => Reflect.get(globalThis, "permissionAsks"))).toBe(0);
  await pushButton(page, "Turn on").click();
  await expect(pushState(page)).toHaveAttribute("data-push-state", "on");
  expect(await page.evaluate(() => Reflect.get(globalThis, "permissionAsks"))).toBe(1);
  expect(await heldSubscriptions()).toEqual([expect.objectContaining({ endpoint: service.endpoint })]);

  await pushButton(page, "Send test").click();
  const tested = await service.next();
  expect(tested.notice).toMatchObject({ v: 1, k: "test" });
  expect(tested.vapidKey).toBe(await subscribedKey(page));

  await pushButton(page, "Turn off").click();
  await expect(pushState(page)).toHaveAttribute("data-push-state", "off");
  expect(await heldSubscriptions()).toEqual([]);
  expect(await subscribedKey(page)).toBeNull();
});

test("a tapped notice opens its pane, in an open window and in a fresh one", async ({ page, context }) => {
  const service = suite.service();
  await turnOn(page);
  const agent = finishingAgent("push-open", suite.endAfterTest);
  press(agent);
  const posted = await service.next();
  expect(posted.notice["k"]).toBe("done");
  const worker = await serviceWorker(context);
  await deliverPush(context, JSON.stringify(posted.notice));
  await tapNotification(worker, String(posted.notice["n"]), "");
  await expect(page.locator(`[data-terminal="${agent}"]`)).toBeVisible({ timeout: 15_000 });

  // With every window closed the worker opens /?notice=<id>; that address alone opens the pane.
  const fresh = await context.newPage();
  await page.close();
  await fresh.goto(`/?notice=${String(posted.notice["n"])}&host=${String(posted.notice["h"])}`);
  await expect(fresh.locator(`[data-terminal="${agent}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(fresh).toHaveURL(/\/$/);
});

test("on a phone a fresh tapped notice opens its pane, not the place the phone remembers", async ({
  page,
  context,
}) => {
  const service = suite.service();
  await turnOn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // The phone was last on its Spaces list: a cold start on / would reopen it, but a tapped notice names its own pane.
  await page.goto("/?v=spaces");
  await expect(page.getByRole("heading", { level: 1, name: "Spaces", exact: true })).toBeVisible({ timeout: 20_000 });
  const agent = finishingAgent("push-cold-phone", suite.endAfterTest);
  press(agent);
  const posted = await service.next();
  const fresh = await context.newPage();
  await fresh.setViewportSize({ width: 390, height: 844 });
  await page.close();
  await fresh.goto(`/?notice=${String(posted.notice["n"])}&host=${String(posted.notice["h"])}`);
  await expect(fresh.locator(`[data-terminal="${agent}"]`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => new URL(fresh.url()).searchParams.get("t")).not.toBeNull();
  expect(new URL(fresh.url()).searchParams.get("v")).toBeNull();
  // Nothing of the remembered place went under it either: Back is the agents list the app opened on.
  await fresh.getByRole("banner").getByRole("button", { name: "Back to agents" }).click();
  await expect(fresh.getByRole("heading", { level: 1, name: "Agents", exact: true })).toBeVisible();
  expect(new URL(fresh.url()).search).toBe("");
});

test("on a phone a tapped notice switches the open terminal in place, so one Back reaches the list (#999)", async ({
  page,
  context,
}) => {
  const service = suite.service();
  await turnOn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  const agent = finishingAgent("push-phone", suite.endAfterTest);
  // Another terminal is open when the notice is tapped: the tap is a switch, which replaces that terminal's entry.
  const open = finishingAgent("push-phone-open", suite.endAfterTest);
  const openRow = page.getByRole("button", { name: /push-phone-open/ }).first();
  await expect(openRow).toBeVisible({ timeout: 20_000 });
  await openRow.click();
  await expect(page.locator(`[data-terminal="${open}"]`)).toBeVisible({ timeout: 15_000 });
  press(agent);
  const posted = await service.next();
  const entries = () => page.evaluate(() => history.length);
  const before = await entries();
  const worker = await serviceWorker(context);
  await deliverPush(context, JSON.stringify(posted.notice));
  await tapNotification(worker, String(posted.notice["n"]), "");
  await expect(page.locator(`[data-terminal="${agent}"]`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("t")).not.toBeNull();
  expect(await entries()).toBe(before);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();
});

test("no notice about the pane this device shows; the other panes still send theirs", async ({ page }) => {
  const service = suite.service();
  await turnOn(page);
  const shown = finishingAgent("push-shown", suite.endAfterTest);
  const other = finishingAgent("push-other", suite.endAfterTest);
  // The app tells the host which pane it shows; the host's ok to that line is when the hold starts.
  const held = new Promise<void>((resolve) => {
    page.on("websocket", (socket) => {
      if (!socket.url().endsWith("/v1/push")) return;
      let told = false;
      socket.on("framesent", ({ payload }) => {
        told ||= Buffer.from(payload).toString().includes(`"terminal":"${shown}"`);
      });
      socket.on("framereceived", ({ payload }) => {
        if (told && Buffer.from(payload).toString().includes('"t":"ok"')) resolve();
      });
    });
  });
  await page.goto("/");
  await agentRow(page, "push-shown", false).click();
  await expect(page.locator(`[data-focused="true"] [data-terminal="${shown}"]`)).toBeVisible({ timeout: 15_000 });
  await held;
  const before = service.posted.length;
  press(shown);
  // Its done is in hc before the other agent's starts, so the host decided about it before the other's notice.
  await expect.poll(() => hcOn("host", ["get", shown, "--json"])).toContain('"state":"done"');
  press(other);
  const posted = await service.next();
  expect(await askHost({ t: "notice", id: posted.notice["n"] })).toEqual({
    t: "notice",
    terminal: other,
    kind: "done",
    context: { machine: expect.any(String), space: "push", terminal: "push-other", agent: "claude" },
  });
  expect(service.posted).toHaveLength(before + 1);
});
