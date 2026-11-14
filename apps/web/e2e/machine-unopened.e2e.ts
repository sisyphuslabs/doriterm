// Opening a session whose machine dropped before the page heard: the attach fails, and the pane says why in plain
// words with Try again, instead of hc's error text.
import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn, reconnect, switchTo } from "./machine-switch.ts";

// A local shell is the first live terminal, so it is the tab that opens on load. The page adopts every terminal no tab
// shows into its machine's layout once that layout loads, and keeps every tab mounted, so a terminal running then is
// attached in the background (#404): the remote session would only lose its line, never fail to open (#572). So an
// anchor on the machine shows its layout has loaded and been adopted, and the session to open starts after that: no
// tab holds it until it is opened, after the drop.
let local = "";
let anchor = "";
let remote = "";
test.beforeEach(() => {
  local = startShell("host", "home");
  anchor = startShell("machine", "anchor");
  remote = "";
});
test.afterEach(() => {
  reconnect();
  if (remote !== "") endAgent("machine", remote);
  endAgent("machine", anchor);
  endAgent("host", local);
});

test("a session on a machine that just dropped shows the didn't-open screen, and Try again attaches", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  // The anchor's view mounts once the machine's layout has loaded and adopted it; later terminals are not adopted. Its
  // tab is in the background, and a pane out of view draws nothing until it shows (#560), so its mount is the sign.
  await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${anchor}"]`)).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  remote = startShell("machine", "fin");
  await expect(agentRow(page, "fin", true)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`)).toHaveCount(0);
  // The page keeps its last machine.list (connected), so the pane tries to attach instead of showing the machine offline.
  const release = socket.hold("machine.list");
  switchTo("drop");
  await expect.poll(() => hcOn("host", ["machine", "ls"]), { timeout: 25_000 }).toContain("unreachable");
  await agentRow(page, "fin", true).click();

  const pane = page.locator('[data-focused="true"]');
  await expect(pane.getByRole("heading", { name: "This terminal didn't open" })).toBeVisible({ timeout: 20_000 });
  await expect(pane).toContainText(`${MACHINE_NAME} can't be reached right now, so this terminal can't open.`);
  expect(await pane.innerText()).not.toMatch(/HcRpcError|Could not open|sh -c|\[object/);

  reconnect();
  release();
  await expect.poll(() => hcOn("host", ["machine", "ls"]), { timeout: 25_000 }).not.toContain("unreachable");
  await pane.getByRole("button", { name: "Try again" }).click();
  const terminal = pane.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  await terminal.click();
  await page.keyboard.type("echo again-$((40+2))\r");
  await expect(terminal).toContainText("again-42", { timeout: 15_000 });
});

test("Try again that attaches before the page hears the machine is back keeps the terminal it opened (#2621)", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await expect(page.locator(`[data-terminal="${MACHINE_NAME}/${anchor}"]`)).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  remote = startShell("machine", "fin");
  await expect(agentRow(page, "fin", true)).toBeVisible({ timeout: 20_000 });
  const release = socket.hold("machine.list");
  switchTo("drop");
  await expect.poll(() => hcOn("host", ["machine", "ls"]), { timeout: 25_000 }).toContain("unreachable");
  await agentRow(page, "fin", true).click();
  const pane = page.locator('[data-focused="true"]');
  await expect(pane.getByRole("heading", { name: "This terminal didn't open" })).toBeVisible({ timeout: 20_000 });

  // The machine is back and Try again attaches while the page still holds the list from before the drop; the list that
  // says the machine is connected arrives only after the terminal is open, as a slow page can see it.
  reconnect();
  await expect.poll(() => hcOn("host", ["machine", "ls"]), { timeout: 25_000 }).not.toContain("unreachable");
  await pane.getByRole("button", { name: "Try again" }).click();
  const terminal = pane.locator(`[data-terminal="${MACHINE_NAME}/${remote}"]`);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  release();
  await terminal.click();
  await page.keyboard.type("echo kept-$((40+2))\r");
  await expect(terminal).toContainText("kept-42", { timeout: 15_000 });
});
