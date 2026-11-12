import { agentRow, endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  machineRow,
  hcOn,
  reconnect,
  STATE_BOUND_MS,
  switchOn,
  switchTo,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
} from "./machine-switch.ts";

const OFFLINE = `${MACHINE_NAME} is offline`;
const READY = "crunch-ready";

/** A working agent on the machine that prints one line, then answers each line it is sent with `got-<line>`. */
function startMarkedAgent(): string {
  const program = `printf '\\033]7501;state=working\\033\\\\'; echo ${READY}; while IFS= read -r l; do echo "got-$l"; done`;
  const out = hcOn("machine", ["run", "--bg", "--name", "crunch", "--label", "space=api", "--", "sh", "-c", program]);
  return String(Reflect.get(Object(JSON.parse(out)), "address"));
}

// #2003 (DORITERM-11): a machine that went offline is said in the status line, as a host that is gone is, with a way
// to try again; the terminal's view stays where it was, and nothing is drawn over it.
test.describe("opening a session on a machine that went offline", () => {
  let address = "";
  test.beforeEach(() => {
    address = startMarkedAgent();
  });
  test.afterEach(() => {
    reconnect();
    endAgent("machine", address);
  });

  test("the status bar says why in plain words, the view stays, and Try again there brings the terminal back", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/");
    await expect(agentRow(page, "crunch", true)).toBeVisible({ timeout: 20_000 });
    switchTo("drop");
    await expect(machineRow(page)).toContainText("offline", { timeout: OFFLINE_BOUND_MS });

    await agentRow(page, "crunch", true).click();
    const pane = page.locator('[data-focused="true"]');
    const view = pane.locator(`[data-terminal="${MACHINE_NAME}/${address}"]`);
    await expect(view).toBeVisible({ timeout: 15_000 });
    await view.evaluate((element) => element.setAttribute("data-while-offline", ""));
    await expect(pane.getByRole("heading", { name: OFFLINE })).toHaveCount(0);
    const bar = page.getByRole("contentinfo");
    const status = bar.getByRole("status").filter({ hasText: OFFLINE });
    await expect(status).toBeVisible();
    await expect(bar).not.toContainText(/HcRpcError|cannot reach|sh -c/);

    switchOn();
    await bar.getByRole("button", { name: "Try again" }).click();
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    await expect(status).toHaveCount(0, { timeout: STATE_BOUND_MS });
    // The same view, never replaced, reaches the program again.
    const kept = pane.locator(`[data-terminal="${MACHINE_NAME}/${address}"][data-while-offline]`);
    await kept.getByRole("textbox").focus();
    await page.keyboard.type("back");
    await page.keyboard.press("Enter");
    await expect(kept).toContainText("got-back", { timeout: 15_000 });
  });

  test("a view attached while its machine was online reaches the program again after the machine was offline", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.goto("/");
    await agentRow(page, "crunch", true).click();
    const pane = page.locator('[data-focused="true"]');
    const view = pane.locator(`[data-terminal="${MACHINE_NAME}/${address}"]`);
    await expect(view).toContainText(READY, { timeout: 20_000 });
    await view.evaluate((element) => element.setAttribute("data-attached-online", ""));
    switchTo("drop");
    const bar = page.getByRole("contentinfo");
    await expect(bar.getByRole("status").filter({ hasText: OFFLINE })).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    switchOn();
    await bar.getByRole("button", { name: "Try again" }).click();
    await expect(machineRow(page)).toContainText("connected", { timeout: STATE_BOUND_MS });
    const kept = pane.locator(`[data-terminal="${MACHINE_NAME}/${address}"][data-attached-online]`);
    await kept.getByRole("textbox").focus();
    await page.keyboard.type("again");
    await page.keyboard.press("Enter");
    await expect(kept).toContainText("got-again", { timeout: 15_000 });
  });

  test("a phone says it in the line under the header and offers no terminal keys, as there is nothing to type into", async ({
    page,
  }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(agentRow(page, "crunch", true)).toBeVisible({ timeout: 20_000 });
    switchTo("drop");
    await expect(page.getByRole("region", { name: "Offline" })).toBeVisible({ timeout: OFFLINE_BOUND_MS });
    await agentRow(page, "crunch", true).click();
    await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${address}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: OFFLINE })).toHaveCount(0);
    // The view waits for its machine: no attach is tried, so it never says it didn't open.
    await expect(page.getByRole("heading", { name: "This terminal didn't open" })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: OFFLINE })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Terminal keys" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show keyboard" })).toHaveCount(0);
  });
});
