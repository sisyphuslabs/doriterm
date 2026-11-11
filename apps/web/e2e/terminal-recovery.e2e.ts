import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { paneOf, seedLayout } from "./layout-doc.ts";

let shell = "";
test.beforeEach(() => {
  shell = startShell("host", "recovery");
  seedLayout([{ id: "tb-recovery", root: [{ pane: "p-recovery", terminal: shell }] }]);
});
test.afterEach(() => endAgent("host", shell));

test("a transient first attach reconnects without ever showing Try again", async ({ page }, info) => {
  const socket = await routeHcSocket(page);
  socket.refuseAttaches("unavailable", 1);
  const release = socket.hold("terminal.attach");
  await page.addInitScript(() => {
    const seen: string[] = [];
    Reflect.set(window, "__recoverySeen", seen);
    new MutationObserver(() => {
      if (document.body?.textContent?.includes("Reconnecting")) seen.push("reconnecting");
      if (document.body?.textContent?.includes("Try again")) seen.push("error");
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.goto("/");
  await expect(page.getByRole("status", { name: "Reconnecting terminal" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("reconnecting.png") });
  release();
  await expect(paneOf(page, shell)).toContainText("$", { timeout: 20_000 });
  const seen: unknown = await page.evaluate(() => Reflect.get(window, "__recoverySeen"));
  expect(seen).toContain("reconnecting");
  expect(seen).not.toContain("error");
  expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.attach"'))).toHaveLength(2);
  expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.run"'))).toHaveLength(0);
  const counts: unknown = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("doriterm.terminal-recovery.v1") ?? "{}"),
  );
  expect(counts).toMatchObject({ views: 1, attachAttempts: 2, errorsShown: 0, automaticRecoveries: 1 });
});

test("an authentication refusal is shown immediately without automatic attempts", async ({ page }) => {
  const socket = await routeHcSocket(page);
  socket.refuseAttaches("unauthorized", Infinity);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This terminal didn't open" })).toBeVisible();
  await expect(page.getByText(/access.*refused/i)).toBeVisible();
  await expect(page.getByText("Reconnecting…", { exact: true })).toHaveCount(0);
  expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.attach"'))).toHaveLength(1);
  expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.get"'))).toHaveLength(0);
});

test("interaction recovers an exhausted attach without replaying the command", async ({ page }) => {
  const socket = await routeHcSocket(page);
  socket.refuseAttaches("unavailable", 4);
  await page.goto("/");
  const pane = page.locator('section[aria-label="recovery terminal"]');
  await expect(pane.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 20_000 });
  expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.attach"'))).toHaveLength(4);
  await pane.getByRole("heading", { name: "This terminal didn't open" }).dispatchEvent("wheel", { deltaY: 20 });
  const terminal = pane.locator(`[data-terminal="${shell}"]`);
  await expect(terminal).toContainText("$", { timeout: 10_000 });
  await terminal.click();
  await page.keyboard.type("printf 'recovered-%s\\n' 42\r");
  await expect(terminal).toContainText("recovered-42");
  expect((await terminal.innerText()).match(/recovered-42/g)).toHaveLength(1);
  expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.attach"'))).toHaveLength(5);
  expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.run"'))).toHaveLength(0);
});

for (const event of ["pointerdown", "keydown", "paste"]) {
  test(`${event} starts recovery after automatic attempts were exhausted`, async ({ page }) => {
    const socket = await routeHcSocket(page);
    socket.refuseAttaches("unavailable", 4);
    await page.goto("/");
    const failure = page.getByRole("heading", { name: "This terminal didn't open" });
    await expect(failure).toBeVisible({ timeout: 20_000 });
    await failure.dispatchEvent(event);
    await expect(page.locator(`[data-terminal="${shell}"]`)).toContainText("$", { timeout: 10_000 });
    expect(socket.sent().filter((frame) => frame.includes('"method":"terminal.attach"'))).toHaveLength(5);
  });
}

test("bursty interaction stays single flight and exhausted recovery stops announcing Reconnecting", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  socket.refuseAttaches("unavailable", Infinity);
  await page.goto("/");
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status", { name: "Reconnecting terminal" })).toHaveCount(0);
  const frame = page.locator(`[data-terminal="${shell}"]`).locator("..");
  await frame.evaluate((element) => {
    for (let i = 0; i < 20; i += 1) element.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status", { name: "Reconnecting terminal" })).toHaveCount(0);
  expect(socket.sent().filter((message) => message.includes('"method":"terminal.attach"'))).toHaveLength(7);
});

for (const width of [1280, 390]) {
  test(`a manual recovery at ${width}px records its immediate success and preserves the screen`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const socket = await routeHcSocket(page);
    socket.refuseAttaches("unavailable", 4);
    await page.goto("/");
    if (width < 600) await agentRow(page, "recovery", false).click();
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: info.outputPath("exhausted.png") });
    await retry.click();
    await expect(page.locator(`[data-terminal="${shell}"]`)).toContainText("$", { timeout: 10_000 });
    await page.screenshot({ path: info.outputPath("recovered.png") });
    const counts: unknown = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("doriterm.terminal-recovery.v1") ?? "{}"),
    );
    expect(counts).toMatchObject({
      views: 1,
      attachAttempts: 5,
      errorsShown: 1,
      manualRetries: 1,
      manualImmediateSuccesses: 1,
      automaticRecoveries: 0,
      interactionRecoveries: 0,
    });
  });
}
