// A space's name lives in hc (the `space` label of its terminals), so a rename on one device shows on every other
// device of that host at once, with no reload (#395).
import type { Browser, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
// The row's name is the space's name, then its git facts and tab count when shown (the actions cover the count on hover).
const spaceRow = (page: Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}(?: |$)`) });

const started: string[] = [];

/** A plain shell in space `space`, started straight on the e2e core. */
function startIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", "env", "PS1=$ ", "sh"]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  const address = String(parsed.address);
  started.push(address);
  return address;
}

/** The space hc itself holds for a terminal: what every client reads. */
function spaceInHc(address: string): unknown {
  const got: unknown = JSON.parse(hcOn("host", ["get", address, "--json"]));
  const labels = typeof got === "object" && got !== null ? Reflect.get(got, "labels") : undefined;
  return typeof labels === "object" && labels !== null ? Reflect.get(labels, "space") : undefined;
}

/** A second device: its own browser context (its own storage) on the same host. */
async function secondDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
  return context.newPage();
}

test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

test("a space renamed from its menu shows the new name on another device at once, and hc holds it", async ({
  page,
  browser,
}) => {
  const [before, after] = [`rn395-a-${test.info().repeatEachIndex}`, `rn395-b-${test.info().repeatEachIndex}`];
  const shells = [startIn(before, "rn-one"), startIn(before, "rn-two")];
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await expect(spaceRow(page, before)).toBeVisible({ timeout: 20_000 });
  await expect(spaceRow(other, before)).toBeVisible({ timeout: 20_000 });

  await spaceRow(page, before).hover();
  await sidebar(page)
    .getByRole("button", { name: `More for ${before}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename space…" }).click();
  const dialog = page.getByRole("dialog", { name: `Rename ${before}` });
  const field = dialog.getByRole("textbox", { name: "Name" });
  await expect(field).toHaveValue(before);
  // A blank name is refused where it was typed, and nothing is written.
  await field.fill("   ");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog.getByText("A space needs a name.")).toBeVisible();
  expect(shells.map(spaceInHc)).toEqual([before, before]);

  await field.fill(`  ${after} `);
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();
  await Promise.all([page, other].map((device) => expect(spaceRow(device, after)).toBeVisible({ timeout: 15_000 })));
  await Promise.all([page, other].map((device) => expect(spaceRow(device, before)).toHaveCount(0)));
  expect(shells.map(spaceInHc)).toEqual([after, after]);
  await other.context().close();
});

test("double-click edits a space's name in place: Esc puts it back, Enter commits it for every device", async ({
  page,
  browser,
}) => {
  const [before, after] = [`rn395-c-${test.info().repeatEachIndex}`, `rn395-d-${test.info().repeatEachIndex}`];
  // Started first, so it is the terminal in view: the double-click's first click opens the renamed space in a new tab.
  startIn(`${before}-shown`, "rn-shown");
  const shells = [startIn(before, "rn-three"), startIn(before, "rn-four")];
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await expect(spaceRow(page, before)).toBeVisible({ timeout: 20_000 });
  await expect(spaceRow(other, before)).toBeVisible({ timeout: 20_000 });

  const input = sidebar(other).getByRole("textbox", { name: `Rename space ${before}` });
  await spaceRow(other, before).dblclick();
  await expect(input).toBeFocused();
  // The double-click's first click opened the space's terminal; once it starts, the field still has the keyboard.
  await expect(other.locator(`[data-terminal="${shells[0]}"][data-ready="true"]`)).toBeVisible({ timeout: 15_000 });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(before);
  await input.fill("never-written");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(spaceRow(other, before)).toBeVisible();
  expect(shells.map(spaceInHc)).toEqual([before, before]);

  await spaceRow(other, before).dblclick();
  await expect(input).toBeFocused();
  await input.fill("");
  await input.press("Enter");
  await expect(sidebar(other).getByRole("alert")).toHaveText("A space needs a name.");
  await expect(input).toBeFocused();
  await input.fill(after);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await Promise.all([other, page].map((device) => expect(spaceRow(device, after)).toBeVisible({ timeout: 15_000 })));
  await Promise.all([other, page].map((device) => expect(spaceRow(device, before)).toHaveCount(0)));
  expect(shells.map(spaceInHc)).toEqual([after, after]);
  await other.context().close();
});

test("a rename still writing keeps its question: Cancel waits, Escape does nothing, and a refused write says why there (#1498)", async ({
  page,
}) => {
  const before = `rn1498-${test.info().repeatEachIndex}`;
  startIn(before, "rn1498-one");
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await expect(spaceRow(page, before)).toBeVisible({ timeout: 20_000 });
  await spaceRow(page, before).hover();
  await sidebar(page)
    .getByRole("button", { name: `More for ${before}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename space\u2026" }).click();
  const question = page.getByRole("dialog", { name: `Rename ${before}` });
  await question.getByRole("textbox", { name: "Name" }).fill(`${before}-b`);

  // The layout write is held, as a slow host would hold it: the rename is in flight, not finished.
  const release = socket.hold("doc.set");
  socket.staleWrites(true);
  await question.getByRole("button", { name: "Rename" }).click();
  await expect(question.getByRole("button", { name: "Rename" })).toHaveAttribute("aria-busy", "true");
  await expect(question.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(question).toBeVisible();
  // So does a click beside the question: the dialog is centred, so the left of its box is the backdrop.
  const box = await question.boundingBox();
  if (box === null) throw new Error("the Rename question has no box");
  await page.mouse.click(Math.max(4, box.x / 2), box.y + box.height / 2);
  await expect(question).toBeVisible();

  // The write is refused on every retry: the question stays up and says why.
  release();
  await expect(
    question.getByText("The layout kept changing on another device, so this change was not saved"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(question).toBeVisible();
});

test("Enter again while a rename is writing names the space once (#1498)", async ({ page }) => {
  const before = `rn1498k-${test.info().repeatEachIndex}`;
  const after = `${before}-b`;
  startIn(before, "rn1498k-one");
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await expect(spaceRow(page, before)).toBeVisible({ timeout: 20_000 });
  await spaceRow(page, before).hover();
  await sidebar(page)
    .getByRole("button", { name: `More for ${before}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename space\u2026" }).click();
  const question = page.getByRole("dialog", { name: `Rename ${before}` });
  const field = question.getByRole("textbox", { name: "Name" });
  await field.fill(after);
  // A rename is one layout write naming the space, then one label per live terminal naming it.
  const writes = (): number =>
    socket.sent().filter((frame) => frame.includes('"method":"doc.set"') && frame.includes(after)).length;
  const labels = (): number =>
    socket.sent().filter((frame) => frame.includes('"method":"terminal.label"') && frame.includes(after)).length;

  // The layout write is held, as a slow host would hold it: the rename is in flight, not finished.
  const release = socket.hold("doc.set");
  await field.press("Enter");
  const rename = question.getByRole("button", { name: "Rename" });
  await expect(rename).toHaveAttribute("aria-busy", "true");
  await expect.poll(writes, { timeout: 15_000 }).toBe(1);
  // Enter again while it is writing: the action is busy, so the same rename, not a second one.
  await field.press("Enter");
  await expect(rename).toHaveAttribute("aria-busy", "true");

  release();
  await expect(question).toBeHidden({ timeout: 15_000 });
  // The second Enter neither wrote the layout nor labelled the terminal again: one rename, once.
  expect(writes()).toBe(1);
  expect(labels()).toBe(1);
  await expect(spaceRow(page, after)).toBeVisible({ timeout: 15_000 });
});
