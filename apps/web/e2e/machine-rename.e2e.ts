import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn, STATE_BOUND_MS } from "./machine-switch.ts";
import { selectedPane, tabOf } from "./tab-strip.ts";
import { holdMachineLayout, routeHcSocket } from "./hc-socket.ts";
import { getCoreDoc } from "./core-doc.ts";

const RENAMED = "build-renamed";

test.describe("renaming a machine with its terminals open", () => {
  let local = "";
  let remote = "";
  let renamed = false;
  test.beforeEach(() => {
    local = startShell("host", "home");
    remote = startShell("machine", "e2e");
  });
  test.afterEach(() => {
    if (renamed) hcOn("host", ["machine", "rename", RENAMED, MACHINE_NAME]);
    renamed = false;
    endAgent("machine", remote);
    endAgent("host", local);
  });

  test("keeps its open tab, now at the new address, and the terminal still answers", async ({ page }) => {
    await page.goto("/");
    await agentRow(page, "home", false).click();
    await agentRow(page, "e2e", true).click();
    const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
    await expect(selectedPane(page, `${MACHINE_NAME}/${remote}`)).toHaveCount(1, { timeout: 20_000 });
    // This machine's tab is in a space of its own machine, so the strip shows only the added machine's (#404).
    await expect(await tabOf(page, local)).toHaveCount(0);
    await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`)).toBeVisible({ timeout: 15_000 });
    const open = await tabs.count();

    hcOn("host", ["machine", "rename", MACHINE_NAME, RENAMED]);
    renamed = true;
    const moved = page.locator(`[data-terminal="${RENAMED}/${remote}"]`);
    await expect(moved).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(tabs).toHaveCount(open);
    await expect(selectedPane(page, `${RENAMED}/${remote}`)).toHaveCount(1);

    await moved.click();
    await page.keyboard.type("echo renamed-$((40 + 2))\r");
    await expect(moved).toContainText("renamed-42", { timeout: 15_000 });
  });

  test("retries a layout write refused at the old name before the rename feed arrives", async ({ page }) => {
    const written = Promise.withResolvers<void>();
    const refused = Promise.withResolvers<void>();
    const saved = Promise.withResolvers<void>();
    let releaseLayout: (() => void) | undefined;
    let heldLayout = false;
    let expected: unknown;
    let writeId: string | undefined;
    let retryId: string | undefined;
    const socket = await routeHcSocket(page, {
      sent: (frame) => {
        if (frame.includes('"method":"doc.set"') && frame.includes(`"on":"${RENAMED}"`))
          retryId = /"id":(\d+)/.exec(frame)?.[1];
        if (!frame.includes(`"on":"${MACHINE_NAME}"`) || !frame.includes('"name":"herdr-app"')) return;
        if (!heldLayout && frame.includes('"method":"doc.get"')) {
          heldLayout = true;
          const id = /"id":(\d+)/.exec(frame)?.[1];
          releaseLayout = socket.holdFromHost(`"id":${id},`);
        }
        if (frame.includes('"method":"doc.set"')) {
          writeId = /"id":(\d+)/.exec(frame)?.[1];
          expected = JSON.parse(frame.slice(frame.indexOf("{"))).params.value;
          written.resolve();
        }
      },
      received: (frame) => {
        if (writeId !== undefined && frame.includes(`"id":${writeId},`) && frame.includes('"kind":"machine_unknown"'))
          refused.resolve();
        if (retryId !== undefined && frame.includes(`"id":${retryId},`) && frame.includes('"result"')) saved.resolve();
      },
    });
    await page.goto("/");
    await agentRow(page, "home", false).click();
    await agentRow(page, "e2e", true).click();
    await expect(selectedPane(page, `${MACHINE_NAME}/${remote}`)).toBeVisible({ timeout: 15_000 });
    // The terminal has a loose tab while its layout loads. The host renames first, but the page still sees the old
    // feed and machine list when that initial read arrives and adopts the terminal into the machine's document.
    const releaseFeed = socket.holdFromHost('"method":"event"', '"method":"heartbeat"', '"method":"missed"');
    const releaseCalls = socket.hold("doc.set", "machine.list");
    hcOn("host", ["machine", "rename", MACHINE_NAME, RENAMED]);
    renamed = true;
    if (releaseLayout === undefined) throw new Error("the page never requested the machine's layout");
    releaseLayout();
    await written.promise;
    // Only now may the old-name write reach hc. Prove it was refused before letting the page hear the rename.
    releaseCalls();
    await refused.promise;
    releaseFeed();

    const moved = selectedPane(page, `${RENAMED}/${remote}`);
    await expect(moved).toBeVisible({ timeout: STATE_BOUND_MS });
    await moved.click();
    await page.keyboard.type("echo raced-$((40 + 2))\r");
    await expect(moved).toContainText("raced-42", { timeout: 15_000 });
    await saved.promise;
    expect(getCoreDoc("herdr-app", RENAMED)).toEqual(expected);
    await page.reload();
    await expect(selectedPane(page, `${RENAMED}/${remote}`)).toBeVisible({ timeout: STATE_BOUND_MS });
  });

  test("keeps a tab opened while the machine's layout was still loading, now at the new address", async ({ page }) => {
    const layout = await holdMachineLayout(page);
    await page.goto("/");
    await agentRow(page, "home", false).click();
    await agentRow(page, "e2e", true).click();
    const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
    await expect(selectedPane(page, `${MACHINE_NAME}/${remote}`)).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`)).toBeVisible({ timeout: 15_000 });
    await layout.requested(STATE_BOUND_MS);
    layout.release();
    const open = await tabs.count();

    hcOn("host", ["machine", "rename", MACHINE_NAME, RENAMED]);
    renamed = true;
    const moved = page.locator(`[data-terminal="${RENAMED}/${remote}"]`);
    await expect(moved).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(tabs).toHaveCount(open);
    await moved.click();
    await page.keyboard.type("echo renamed-$((40 + 2))\r");
    await expect(moved).toContainText("renamed-42", { timeout: 15_000 });
  });

  test("on a phone, stays in the open terminal, now at the new address, and it still answers", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await agentRow(page, "e2e", true).click();
    await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`)).toContainText("$", { timeout: 15_000 });

    hcOn("host", ["machine", "rename", MACHINE_NAME, RENAMED]);
    renamed = true;
    const moved = page.locator(`[data-terminal="${RENAMED}/${remote}"]`);
    await expect(moved).toBeVisible({ timeout: STATE_BOUND_MS });
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible();
    await moved.click();
    await page.keyboard.type("echo renamed-$((40 + 2))\r");
    await expect(moved).toContainText("renamed-42", { timeout: 15_000 });
  });
});
