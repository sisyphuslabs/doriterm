// A space's "..." menu offers Close space..., which asks first and then ends the space's tabs on every device of the
// machine, as herdr-app's space menu does (Close -> space.close, "asks first unless confirmed").
import type { Browser, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { getCoreDoc } from "./core-doc.ts";
import { expect, terminalCount, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const spaceRow = (page: Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}(?: |$)`) });
const ask = (page: Page) => page.getByRole("dialog", { name: "Close space?" });

/** The space row's "..." menu, open; its Close space... item. */
async function openSpaceMenu(page: Page, name: string): Promise<void> {
  await spaceRow(page, name).hover();
  await sidebar(page)
    .getByRole("button", { name: `More for ${name}` })
    .click();
}

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

/** A second device: its own browser context (its own storage) on the same host. */
async function secondDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
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

test("a space closed from its menu asks first, naming its tabs; Escape and Cancel keep it, and Close takes it and its terminals with it on every device", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = `cl612-${test.info().repeatEachIndex}`;
  startIn(name, "cl-one");
  startIn(name, "cl-two");
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await expect(spaceRow(page, name)).toBeVisible({ timeout: 20_000 });
  await expect(spaceRow(other, name)).toBeVisible({ timeout: 20_000 });
  // Two terminals of one space are two tabs of it, on both devices.
  await expect(page.getByRole("tab")).toHaveCount(2, { timeout: 20_000 });
  await expect(other.getByRole("tab")).toHaveCount(2, { timeout: 20_000 });

  // The question names the space and what it holds: two tabs, two terminals.
  await openSpaceMenu(page, name);
  const item = page.getByRole("menuitem", { name: "Close space\u2026" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(ask(page)).toContainText(`${name} \u2014 2 tabs, 2 terminals`);

  // Escape keeps the space: it, its tabs and its terminals are still there, on both devices.
  await page.keyboard.press("Escape");
  await expect(ask(page)).toHaveCount(0);
  await expect(spaceRow(page, name)).toBeVisible();
  await expect(spaceRow(other, name)).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);

  // So does Cancel.
  await openSpaceMenu(page, name);
  await page.getByRole("menuitem", { name: "Close space\u2026" }).click();
  await ask(page).getByRole("button", { name: "Cancel" }).click();
  await expect(ask(page)).toHaveCount(0);
  await expect(spaceRow(page, name)).toBeVisible();
  await expect(spaceRow(other, name)).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(2);

  // Close takes the space and its tabs out of the document, so the other device drops it too without a reload, and both
  // programs end.
  const running = (await terminalCount(page)).before;
  await openSpaceMenu(page, name);
  await page.getByRole("menuitem", { name: "Close space\u2026" }).click();
  await ask(page).getByRole("button", { name: "Close" }).click();
  await expect(ask(page)).toHaveCount(0);
  await expect(spaceRow(page, name)).toHaveCount(0, { timeout: 15_000 });
  await expect(spaceRow(other, name)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("tab")).toHaveCount(0, { timeout: 15_000 });
  await expect(other.getByRole("tab")).toHaveCount(0, { timeout: 15_000 });
  await Promise.all(
    [page, other].map((device) =>
      expect(device.getByRole("contentinfo")).toContainText(`${running - 2} terminal`, { timeout: 20_000 }),
    ),
  );
  const doc: unknown = getCoreDoc("herdr-app");
  const spaces = typeof doc === "object" && doc !== null && "spaces" in doc ? doc.spaces : undefined;
  const named = Array.isArray(spaces)
    ? spaces.map((space: unknown) =>
        typeof space === "object" && space !== null && "name" in space ? space.name : null,
      )
    : [];
  expect(named).not.toContain(name);
  // Their programs ended with the space, so the cleanup has nothing left to end; a run that fails above still leaves them
  // to it.
  started.splice(0);
  await other.context().close();
});

test("a close still writing keeps its question: Cancel waits, Escape does nothing, and a refused write says why there (#1498)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = `cl1498-${test.info().repeatEachIndex}`;
  startIn(name, "cl1498-one");
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await expect(spaceRow(page, name)).toBeVisible({ timeout: 20_000 });
  await openSpaceMenu(page, name);
  await page.getByRole("menuitem", { name: "Close space\u2026" }).click();
  const question = ask(page);
  await expect(question).toContainText(`${name} \u2014 1 tab, 1 terminal`);

  // The layout write is held, as a slow host would hold it: the close is in flight, not finished.
  const release = socket.hold("doc.set");
  socket.staleWrites(true);
  await question.getByRole("button", { name: "Close" }).click();
  await expect(question.getByRole("button", { name: "Close" })).toHaveAttribute("aria-busy", "true");
  // The held write comes after the close ended its program: nothing is left for the cleanup to stop.
  await expect
    .poll(() => socket.sent().filter((frame) => frame.includes('"method":"doc.set"')).length, { timeout: 15_000 })
    .toBe(1);
  started.splice(0);
  await expect(question.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(question).toBeVisible();

  // The write is refused on every retry: the question stays up and says why.
  release();
  await expect(question.getByText("The space was not closed")).toBeVisible({ timeout: 15_000 });
  await expect(
    question.getByText("The layout kept changing on another device, so this change was not saved"),
  ).toBeVisible();
  await expect(question).toBeVisible();
});
