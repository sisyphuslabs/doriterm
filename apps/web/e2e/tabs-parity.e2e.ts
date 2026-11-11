// The #404 parity list, one test per item that is testable on one machine: tabs belong to a space as in herdr-app. Items
// an existing spec already proves are named there instead of repeated here:
// - 3: split-tree.e2e.ts (an unlimited nested row/column tree, kept across a reload; focus moves between panes).
// - 5: tab-reorder.e2e.ts (a drag persists across a reload). Dragging a pane onto a tab is not a herdr-app move (ruling
//   C): its panes drag only within their split tab, and a drop outside another pane cancels (pane-move.e2e.ts, #408).
// - 6: close-ends-program.e2e.ts (#426's confirm rules); close-last-tab.e2e.ts (the last tab asks Close space?).
// - 7: focus-ring.e2e.ts (focus-visible rings on the strip's controls).
// - 8: space-rename.e2e.ts (a space rename shows on another device at once).
// - 9: space-rename-relay.e2e.ts (two devices over the relay); layout-sync.e2e.ts (splits on two devices at once).
// - 10: phone-header.e2e.ts (the 44 px switch button and its sheet); phone-panes.e2e.ts (a split tab on a phone).
// - 11: tabs-per-space.e2e.ts (adoption into the folder's space, else Home, once); machine-rename.e2e.ts (#495).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, devices, type Locator, type Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { getCoreDoc } from "./core-doc.ts";
import { expect, laidOutBox, opened, test, pressNewTab } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { LAYOUT_DOC, paneOf, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { pressShortcut, shortcut } from "./platform-keys.ts";
import { tabNumberChord } from "./tab-strip.ts";

/** A tab's row in the Spaces sheet, not its Close control or the space's New tab (#1463). */
const tabRows = (page: Page, region: Locator) =>
  region.getByRole("button").filter({ has: page.locator('[data-floor="name"]') });

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

interface SavedTab {
  readonly id?: string;
  readonly name?: string;
  readonly root?: unknown;
}

function saved(): readonly { readonly id?: string; readonly name?: string; readonly tabs?: readonly SavedTab[] }[] {
  const doc = getCoreDoc(LAYOUT_DOC) as { spaces?: { id?: string; name?: string; tabs?: SavedTab[] }[] } | null;
  return doc?.spaces ?? [];
}

/** Each saved space's name and its tabs' names, in the document's order. */
const savedSpaces = () => saved().map((space) => [space.name ?? "", (space.tabs ?? []).map((tab) => tab.name ?? "")]);

/** How many panes the saved tab `id` holds. */
function panesIn(id: string): number {
  const tab = saved()
    .flatMap((space) => space.tabs ?? [])
    .find((each) => each.id === id);
  const count = (node: unknown): number => {
    if (typeof node !== "object" || node === null) return 0;
    const children = (node as { children?: unknown[] }).children;
    return Array.isArray(children) ? children.reduce<number>((sum, child) => sum + count(child), 0) : 1;
  };
  return count(tab?.root);
}

/** Whether hc still lists the terminal live. */
function live(address: string): boolean {
  const listed = JSON.parse(hcOn("host", ["ls", "--json"])) as { terminals?: { address?: string; state?: string }[] };
  return (listed.terminals ?? []).some((each) => each.address === address && each.state === "live");
}

/** A plain shell started straight on the core in `cwd`, in no tab; named, so its tab reads that name. */
function shellIn(cwd: string, name?: string): string {
  const named = name === undefined ? [] : ["--name", name];
  const out = hcOn("host", ["run", "--bg", ...named, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  return String((JSON.parse(out) as { address: string }).address);
}

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const tabItem = (page: Page, text: string) =>
  page.getByRole("tablist", { name: "Tabs" }).locator("[data-tab-id]").filter({ hasText: text });
const selected = (page: Page) => page.getByRole("tab", { selected: true });
/** A row of the phone's Spaces sheet by the name it shows, the tab's title. */
const tabRow = (scope: Locator, title: string) =>
  scope.getByRole("button").filter({ has: scope.page().locator(`[data-floor="name"][title="${title}"]`) });
const spaceRow = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });
const focusedTerminal = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');
/** The page platform's chord for an action, as the default keymap binds it (keys/defaults.ts). */
function chord(page: Page, action: "new" | "close" | "right" | "down"): Promise<string> {
  const actions = { new: "tab.new", close: "tab.close", right: "pane.split:right", down: "pane.split:down" };
  return shortcut(page, actions[action]);
}

interface Spaces {
  readonly alpha: string;
  readonly beta: string;
  readonly shells: Readonly<Record<"a1" | "a2" | "b1" | "b2", string>>;
}

/** Two spaces of two tabs each, every tab one shell started in its space's folder. */
function twoSpaces(): Spaces {
  const root = mkdtempSync(join(tmpdir(), "tabs-parity-"));
  const alpha = mkdtempSync(join(root, "alpha-"));
  const beta = mkdtempSync(join(root, "beta-"));
  const shells = {
    a1: shellIn(alpha, "parity-a1"),
    a2: shellIn(alpha, "parity-a2"),
    b1: shellIn(beta, "parity-b1"),
    b2: shellIn(beta, "parity-b2"),
  };
  seedSpaces([
    {
      id: "spc-alpha",
      name: "alpha",
      folder: alpha,
      tabs: [
        { id: "tb-a1", name: "a-one", terminal: shells.a1 },
        { id: "tb-a2", name: "a-two", terminal: shells.a2 },
      ],
    },
    {
      id: "spc-beta",
      name: "beta",
      folder: beta,
      tabs: [
        { id: "tb-b1", name: "b-one", terminal: shells.b1 },
        { id: "tb-b2", name: "b-two", terminal: shells.b2 },
      ],
    },
  ]);
  return { alpha, beta, shells };
}

/** A second device: its own browser context (its own storage, so its own selection) on the same host. */
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

test("1: the strip shows only the selected space's tabs, and a space comes back on its last tab, also after a reload", async ({
  page,
}) => {
  twoSpaces();
  await page.goto("/");
  await spaceRow(page, "alpha").click();
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/]);
  await tabBar(page).filter({ hasText: "a-two" }).click();
  await spaceRow(page, "beta").click();
  await expect(tabBar(page)).toHaveText([/b-one/, /b-two/]);
  await tabBar(page).filter({ hasText: "b-two" }).click();
  await expect(selected(page)).toHaveText(/b-two/);

  await page.reload();
  await expect(tabBar(page)).toHaveText([/b-one/, /b-two/], { timeout: 20_000 });
  await expect(selected(page)).toHaveText(/b-two/);
  await spaceRow(page, "alpha").click();
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/]);
  await expect(selected(page)).toHaveText(/a-two/);
  await spaceRow(page, "beta").click();
  await expect(selected(page)).toHaveText(/b-two/);
});

test('2: the New tab chord and "+" add a focused tab after the active one, in the space\'s folder, ready for typing', async ({
  page,
}) => {
  const { beta, shells } = twoSpaces();
  await page.goto("/");
  await spaceRow(page, "beta").click();
  await tabBar(page).filter({ hasText: "b-one" }).click();
  await paneOf(page, shells.b1).getByRole("textbox").focus();

  await page.keyboard.press(await chord(page, "new"));
  // Typed straight away: it reaches the new tab, which starts where the space is.
  await page.keyboard.type("echo at-$PWD-key");
  await page.keyboard.press("Enter");
  await expect(tabBar(page)).toHaveCount(3, { timeout: 15_000 });
  await expect(focusedTerminal(page)).toContainText(`at-${beta}-key`, { timeout: 15_000 });
  await expect(selected(page)).toHaveAttribute("aria-selected", "true");
  await expect.poll(savedSpaces, { timeout: 15_000 }).toEqual([
    ["alpha", ["a-one", "a-two"]],
    ["beta", ["b-one", "", "b-two"]],
  ]);

  await pressNewTab(page.getByRole("button", { name: "New tab" }));
  await page.keyboard.type("echo at-$PWD-plus");
  await page.keyboard.press("Enter");
  await expect(tabBar(page)).toHaveCount(4, { timeout: 15_000 });
  await expect(focusedTerminal(page)).toContainText(`at-${beta}-plus`, { timeout: 15_000 });
  await expect.poll(savedSpaces, { timeout: 15_000 }).toEqual([
    ["alpha", ["a-one", "a-two"]],
    ["beta", ["b-one", "", "", "b-two"]],
  ]);
  await expect(tabBar(page).nth(2)).toHaveAttribute("aria-selected", "true");
});

test("3: the split chords split only the current tab, nested, and a tab whose last pane ends closes", async ({
  page,
}) => {
  const { shells } = twoSpaces();
  await page.goto("/");
  await spaceRow(page, "beta").click();
  await tabBar(page).filter({ hasText: "b-one" }).click();
  await paneOf(page, shells.b1).getByRole("textbox").focus();
  await page.keyboard.press(await chord(page, "right"));
  await expect.poll(() => panesIn("tb-b1"), { timeout: 15_000 }).toBe(2);
  await expect(focusedTerminal(page)).not.toHaveAttribute("data-terminal", shells.b1, { timeout: 15_000 });
  await page.keyboard.press(await chord(page, "down"));
  await expect.poll(() => panesIn("tb-b1"), { timeout: 15_000 }).toBe(3);
  await expect(tabBar(page)).toHaveText([/b-one/, /b-two/]);
  expect([panesIn("tb-a1"), panesIn("tb-a2"), panesIn("tb-b2")]).toEqual([1, 1, 1]);

  await tabBar(page).filter({ hasText: "b-two" }).click();
  await paneOf(page, shells.b2).getByRole("textbox").focus();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(tabBar(page)).toHaveText([/b-one/], { timeout: 15_000 });
  await expect.poll(savedSpaces, { timeout: 15_000 }).toEqual([
    ["alpha", ["a-one", "a-two"]],
    ["beta", ["b-one"]],
  ]);
});

test("4 (A): a tab reads its name, else its number, with its program's icon; it does not follow the pane's title and has no tooltip", async ({
  page,
}) => {
  const folder = mkdtempSync(join(tmpdir(), "tabs-parity-title-"));
  const [first, second] = [shellIn(folder), shellIn(folder)];
  seedSpaces([
    {
      id: "spc-title",
      name: "titles",
      folder,
      tabs: [
        { id: "tb-t1", name: "", terminal: first },
        { id: "tb-t2", name: "named", terminal: second },
      ],
    },
  ]);
  await page.goto("/");
  await expect(tabBar(page)).toHaveText(["1", "named"], { timeout: 20_000 });
  hcOn("host", ["send", first, "printf '\\033]0;a-program-title\\007'"]);
  await expect(page.getByRole("button", { name: "Session actions for a-program-title" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(tabBar(page)).toHaveText(["1", "named"]);
  await expect(tabBar(page).and(page.locator("[title]"))).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Tabs" }).locator("[title]")).toHaveCount(0);
  await expect(tabBar(page).first().locator("svg.lucide-terminal")).toHaveCount(1);

  // A split pane in focus does not rename the tab; the number is its place, so a move renumbers it.
  await paneOf(page, first).getByRole("textbox").focus();
  await page.keyboard.press(await chord(page, "right"));
  await expect.poll(() => panesIn("tb-t1"), { timeout: 15_000 }).toBe(2);
  await expect(tabBar(page)).toHaveText(["1", "named"]);
  await tabBar(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move tab right" }).click();
  await expect(tabBar(page)).toHaveText(["named", "2"], { timeout: 15_000 });
});

test("4 (#1541): an unnamed tab that runs an agent reads the agent's title; a shell's keeps its number; a name wins", async ({
  page,
}) => {
  const folder = mkdtempSync(join(tmpdir(), "tabs-parity-agent-"));
  const report = "printf '\\033]7501;state=blocked\\033\\\\'; exec sleep 600";
  const started: unknown = JSON.parse(
    hcOn("host", ["run", "--bg", "--name", "reviewer", "--cwd", folder, "--", "sh", "-c", report]),
  );
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error("no agent address");
  const agent = String(started.address);
  const shell = shellIn(folder);
  seedSpaces([
    {
      id: "spc-agent-title",
      name: "agents",
      folder,
      tabs: [
        { id: "tb-a1", name: "", terminal: agent },
        { id: "tb-a2", name: "", terminal: shell },
      ],
    },
  ]);
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/^reviewer/, "2"], { timeout: 20_000 });
  await expect(tabBar(page).first().locator("svg.lucide-bot")).toHaveCount(1);

  await tabBar(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename tab…" }).click();
  const rename = page.getByRole("dialog", { name: "Rename reviewer" });
  await rename.getByRole("textbox", { name: "Name" }).fill("triage");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(tabBar(page)).toHaveText([/^triage/, "2"], { timeout: 15_000 });

  // An empty name gives the tab its agent's title back, not a number.
  await tabBar(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename tab…" }).click();
  const clear = page.getByRole("dialog", { name: "Rename triage" });
  await clear.getByRole("textbox", { name: "Name" }).fill("");
  await clear.getByRole("button", { name: "Rename" }).click();
  await expect(tabBar(page)).toHaveText([/^reviewer/, "2"], { timeout: 15_000 });
});

test("5: a tab moved in the strip keeps its place in the document, and another device shows the new order", async ({
  page,
  browser,
}) => {
  twoSpaces();
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await spaceRow(page, "beta").click();
  await spaceRow(other, "beta").click();
  await expect(tabBar(other)).toHaveText([/b-one/, /b-two/], { timeout: 20_000 });
  await tabBar(page).filter({ hasText: "b-one" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move tab right" }).click();
  await expect(tabBar(page)).toHaveText([/b-two/, /b-one/]);
  await expect(tabBar(other)).toHaveText([/b-two/, /b-one/], { timeout: 15_000 });
  await expect.poll(savedSpaces, { timeout: 15_000 }).toEqual([
    ["alpha", ["a-one", "a-two"]],
    ["beta", ["b-two", "b-one"]],
  ]);
  await other.context().close();
});

test("6 (B, D): only the active tab has a close button; a middle-click closes nothing; a space's last tab asks Close space? and closes the space", async ({
  page,
}) => {
  const { shells } = twoSpaces();
  await page.goto("/");
  await spaceRow(page, "beta").click();
  await tabBar(page).filter({ hasText: "b-one" }).click();
  await expect(tabItem(page, "b-one").getByRole("button", { name: /^Close / })).toHaveCount(1);
  await expect(tabItem(page, "b-two").getByRole("button", { name: /^Close / })).toHaveCount(0);

  await tabItem(page, "b-two").click({ button: "middle" });
  await expect(tabBar(page)).toHaveText([/b-one/, /b-two/]);
  expect(live(shells.b2)).toBe(true);

  // Its menu closes any tab, as herdr-app's tab menu (Rename, New tab, Close), then pins it or closes the tabs around it
  // (#1561).
  await tabItem(page, "b-two").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    /^Move tab left/,
    /^Move tab right/,
    /^Rename tab…/,
    /^New tab/,
    /^Pin tab/,
    /^Close tab$/,
    /^Close tabs to the right/,
    /^Close other tabs/,
  ]);
  await page.getByRole("menuitem", { name: "Close tab", exact: true }).click();
  await expect(tabBar(page)).toHaveText([/b-one/], { timeout: 15_000 });
  await expect.poll(() => live(shells.b2), { timeout: 15_000 }).toBe(false);

  // The space's last tab takes the space with it, and asks first, naming its tabs and terminals (herdr-app space.close).
  await paneOf(page, shells.b1).getByRole("textbox").focus();
  await page.keyboard.press(await chord(page, "close"));
  const ask = page.getByRole("dialog", { name: "Close space?" });
  await expect(ask).toContainText("beta \u2014 1 tab, 1 terminal");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toBeHidden();
  expect(live(shells.b1)).toBe(true);
  await page.getByRole("button", { name: "Close b-one" }).click();
  await page.getByRole("dialog", { name: "Close space?" }).getByRole("button", { name: "Close" }).click();
  await expect(spaceRow(page, "beta")).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(savedSpaces, { timeout: 15_000 }).toEqual([["alpha", ["a-one", "a-two"]]]);
  await expect.poll(() => live(shells.b1), { timeout: 15_000 }).toBe(false);
  // herdr-app's remove_space: the space that takes its place, else the last, is shown.
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/]);

  await page.getByRole("button", { name: "Close a-one" }).click();
  await expect(tabBar(page)).toHaveText([/a-two/], { timeout: 15_000 });
  await page.getByRole("button", { name: "Close a-two" }).click();
  await page.getByRole("dialog", { name: "Close space?" }).getByRole("button", { name: "Close" }).click();
  await expect(tabBar(page)).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "New terminal" })).toBeVisible();
});

test("7: Ctrl+Tab, Ctrl+Shift+Tab and the number chords move within the selected space only", async ({ page }) => {
  const { shells } = twoSpaces();
  await page.goto("/");
  await spaceRow(page, "beta").click();
  await tabBar(page).filter({ hasText: "b-one" }).click();
  await expect(page.getByRole("tablist", { name: "Tabs" })).toBeVisible();
  await paneOf(page, shells.b1).getByRole("textbox").focus();

  await pressShortcut(page, "tab.next");
  await expect(selected(page)).toHaveText(/b-two/);
  await pressShortcut(page, "tab.next");
  await expect(selected(page)).toHaveText(/b-one/);
  await pressShortcut(page, "tab.prev");
  await expect(selected(page)).toHaveText(/b-two/);
  await page.keyboard.press(await tabNumberChord(page, 1));
  await expect(selected(page)).toHaveText(/b-one/);
  await page.keyboard.press(await tabNumberChord(page, 2));
  await expect(selected(page)).toHaveText(/b-two/);
  await page.keyboard.press(await tabNumberChord(page, 3));
  await expect(selected(page)).toHaveText(/b-two/);
  await expect(tabBar(page)).toHaveText([/b-one/, /b-two/]);
  await expect(tabBar(page).filter({ hasText: "b-one" })).toHaveAttribute("aria-selected", "false");
});

test("8 (E): a tab renamed by a double-click, F2 or its menu shows the name on every device; Shift+F2 renames the space", async ({
  page,
  browser,
}) => {
  const { shells } = twoSpaces();
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await spaceRow(page, "alpha").click();
  await spaceRow(other, "alpha").click();
  await expect(tabBar(other)).toHaveText([/a-one/, /a-two/], { timeout: 20_000 });

  await tabBar(page).filter({ hasText: "a-one" }).dblclick();
  const dialog = page.getByRole("dialog", { name: "Rename a-one" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("a-one");
  await dialog.getByRole("textbox", { name: "Name" }).fill("fix login");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();
  await expect(tabBar(page)).toHaveText([/fix login/, /a-two/]);
  await expect(tabBar(other)).toHaveText([/fix login/, /a-two/], { timeout: 15_000 });

  // F2 from the terminal renames the tab in view, as herdr-app's keys.
  await tabBar(page).filter({ hasText: "a-two" }).click();
  await paneOf(page, shells.a2).getByRole("textbox").focus();
  await page.keyboard.press("F2");
  const byKey = page.getByRole("dialog", { name: "Rename a-two" });
  await byKey.getByRole("textbox", { name: "Name" }).fill("review");
  await page.keyboard.press("Enter");
  await expect(tabBar(page)).toHaveText([/fix login/, /review/]);
  await expect(tabBar(other)).toHaveText([/fix login/, /review/], { timeout: 15_000 });
  await expect.poll(savedSpaces).toEqual([
    ["alpha", ["fix login", "review"]],
    ["beta", ["b-one", "b-two"]],
  ]);

  // An empty name gives the tab its number back.
  await tabBar(page).filter({ hasText: "fix login" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename tab…" }).click();
  const again = page.getByRole("dialog", { name: "Rename fix login" });
  await again.getByRole("textbox", { name: "Name" }).fill("");
  await again.getByRole("button", { name: "Rename" }).click();
  await expect(tabBar(page)).toHaveText(["1", /review/], { timeout: 15_000 });
  await expect(tabBar(other)).toHaveText(["1", /review/], { timeout: 15_000 });

  await paneOf(page, shells.a2).getByRole("textbox").focus();
  await page.keyboard.press("Shift+F2");
  await expect(page.getByRole("dialog", { name: "Rename alpha" })).toBeVisible();
  await page.keyboard.press("Escape");
  await other.context().close();
});

test("8 (E): a rename chosen from a tab's menu keeps the keyboard, so the name typed at once is its own", async ({
  page,
}) => {
  twoSpaces();
  await page.goto("/");
  await spaceRow(page, "alpha").click();
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/], { timeout: 20_000 });

  await tabBar(page).filter({ hasText: "a-one" }).click({ button: "right" });
  // Subscribed before the menu closes, which happens a moment after its item opened the dialog: focus must stay in the
  // dialog. Resolves on the first focus taken outside it, else empty once the close can no longer move focus.
  const taken = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener(
          "focusin",
          (event) => {
            const target = event.target as HTMLElement;
            if (target.closest('[role="dialog"]') === null && target.closest('[role="menu"]') === null)
              resolve(`${target.tagName} ${target.textContent ?? ""}`.trim());
          },
          true,
        );
        setTimeout(() => resolve(""), 2_000);
      }),
  );
  await page.getByRole("menuitem", { name: "Rename tab…" }).click();
  const field = page.getByRole("dialog", { name: "Rename a-one" }).getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await taken).toBe("");

  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(field).toHaveValue("a-one!");
});

test("E: the ninth number chord selects the ninth tab, not the last", async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), "tabs-parity-nine-"));
  const shells = Array.from({ length: 11 }, () => shellIn(folder));
  seedSpaces([
    {
      id: "spc-nine",
      name: "nine",
      folder,
      tabs: shells.map((terminal, index) => ({ id: `tb-n${index}`, name: `n${index + 1}`, terminal })),
    },
  ]);
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(11, { timeout: 20_000 });
  await tabBar(page).first().click();
  await paneOf(page, shells[0] ?? "")
    .getByRole("textbox")
    .focus();
  await page.keyboard.press(await tabNumberChord(page, 9));
  await expect(selected(page)).toHaveText("n9");
  await page.keyboard.press(await tabNumberChord(page, 1));
  await expect(selected(page)).toHaveText("n1");
});

test("9: a device that was offline converges on the order and names another device changed meanwhile", async ({
  page,
  browser,
}) => {
  twoSpaces();
  const other = await secondDevice(browser);
  const link = await routeHcSocket(other);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await spaceRow(page, "beta").click();
  await spaceRow(other, "beta").click();
  await expect(tabBar(other)).toHaveText([/b-one/, /b-two/], { timeout: 20_000 });

  await link.drop(true);
  await expect(other.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible({ timeout: 15_000 });
  await tabBar(page).filter({ hasText: "b-one" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move tab right" }).click();
  await tabBar(page).filter({ hasText: "b-one" }).dblclick();
  const dialog = page.getByRole("dialog", { name: "Rename b-one" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("while away");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(tabBar(page)).toHaveText([/b-two/, /while away/]);
  await expect(tabBar(other)).toHaveText([/b-one/, /b-two/]);

  link.restore();
  await expect(tabBar(other)).toHaveText([/b-two/, /while away/], { timeout: 20_000 });
  await other.context().close();
});

test.describe("10: on a phone at 390", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use({ ...phone });

  test("10C: the header reads the tab's name, as the strip does; the switch sheet lists each space's tabs with 44 px targets and opens the tab picked", async ({
    page,
  }) => {
    twoSpaces();
    await page.goto("/");
    expect(page.viewportSize()?.width).toBe(390);
    await agentRow(page, "parity-b1", false).click();
    const header = page.getByRole("banner");
    // The tab's name, not the terminal's (ruling A).
    await expect(header.getByRole("heading", { name: "b-one", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(header.getByRole("heading", { name: "parity-b1" })).toHaveCount(0);
    // One strip, as herdr-app: the tab's place and the switch are the bottom tabs bar's alone, not the header's.
    // By the switch's name pattern: a switch in the header whose name starts with "Switch" fails here (#2356).
    await expect(header.getByRole("button", { name: /^Switch/ })).toHaveCount(0);
    await expect(header.locator("[data-tab-position]")).toHaveCount(0);
    const switcher = page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });
    await expect(switcher).toContainText("1/2");
    const box = await laidOutBox(switcher);
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);

    await switcher.click();
    const sheet = page.getByRole("dialog", { name: "Switch" });
    // Measured at rest: a frame of the open transition reads a row a hair under 44 (#583).
    await opened(sheet);
    // It opens on the session's own space; every space is one segment away (mobile nav phase 4).
    await sheet.getByRole("group", { name: "Show" }).getByRole("button", { name: "All spaces" }).click();
    // Each row is named as the strip names its tab, the terminal it opens after it (ruling A).
    const rows = [
      ["alpha", "a-one"],
      ["alpha", "a-two"],
      ["beta", "b-one"],
      ["beta", "b-two"],
    ] as const;
    const heights = await Promise.all(
      rows.map(
        async ([space, row]) =>
          (await laidOutBox(agentRow(sheet.getByRole("region", { name: space }), row, false))).height,
      ),
    );
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    const beta = sheet.getByRole("region", { name: "beta" });
    await expect(tabRows(page, beta)).toHaveCount(2);
    await expect(tabRow(beta, "b-one")).toContainText("parity-b1");
    await expect(tabRow(beta, "b-two")).toContainText("parity-b2");
    await expect(tabRow(beta, "parity-b1")).toHaveCount(0);
    await agentRow(beta, "b-two", false).click();
    await expect(sheet).toBeHidden();
    await expect(header.getByRole("heading", { name: "b-two", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toContainText("2/2");
  });

  test("10B: a tabs bar in the bottom third, with 44 px targets, steps between the space's tabs by touch and opens the sheet", async ({
    page,
  }) => {
    twoSpaces();
    await page.goto("/");
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    await agentRow(page, "parity-b1", false).click();
    const header = page.getByRole("banner");
    await expect(header.getByRole("heading", { name: "b-one", exact: true })).toBeVisible({ timeout: 15_000 });
    const bar = page.getByRole("navigation", { name: "Tabs in this space" });
    const previous = bar.getByRole("button", { name: "Previous tab" });
    const next = bar.getByRole("button", { name: "Next tab" });
    const all = bar.getByRole("button", { name: /^Switch tab, beta, b-one, tab 1 of 2/ });
    // Thumb reach: every target sits in the screen's bottom third.
    const height = page.viewportSize()?.height ?? 0;
    const boxes = await Promise.all([previous, all, next].map(laidOutBox));
    for (const box of boxes) {
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual((height * 2) / 3);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
    }

    await next.tap();
    await expect(header.getByRole("heading", { name: "b-two", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toContainText("2/2");
    // It wraps, as Ctrl+Tab does on the strip.
    await bar.getByRole("button", { name: "Next tab" }).tap();
    await expect(header.getByRole("heading", { name: "b-one", exact: true })).toBeVisible({ timeout: 15_000 });
    await bar.getByRole("button", { name: "Previous tab" }).tap();
    await expect(header.getByRole("heading", { name: "b-two", exact: true })).toBeVisible({ timeout: 15_000 });

    // Its middle opens the spaces sheet, for a tab of another space.
    await bar.getByRole("button", { name: /^Switch tab, beta, b-two/ }).tap();
    const sheet = page.getByRole("dialog", { name: "Switch" });
    // Measured at rest: a frame of the open transition reads a row a hair under 44 (#583).
    await opened(sheet);
    await sheet.getByRole("group", { name: "Show" }).getByRole("button", { name: "All spaces" }).tap();
    await tabRow(sheet.getByRole("region", { name: "alpha" }), "a-two").tap();
    await expect(sheet).toBeHidden();
    await expect(header.getByRole("heading", { name: "a-two", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(bar.getByRole("button", { name: /^Switch tab, alpha, a-two, tab 2 of 2/ })).toBeVisible();
  });

  test("a split tab is one tab: the tabs bar counts 2/3 for 3 tabs and the sheet lists each tab once", async ({
    page,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "tabs-parity-split-"));
    const [one, two, twoBeside, three] = [
      shellIn(folder, "split-w1"),
      shellIn(folder, "split-w2"),
      shellIn(folder, "split-w2b"),
      shellIn(folder, "split-w3"),
    ];
    seedSpaces([
      {
        id: "spc-web",
        name: "web",
        folder,
        tabs: [
          { id: "tb-w1", name: "", terminal: one },
          { id: "tb-w2", name: "", terminal: two, beside: [twoBeside] },
          { id: "tb-w3", name: "", terminal: three },
        ],
      },
    ]);
    await page.goto("/");
    await agentRow(page, "split-w2", false).click();
    const header = page.getByRole("banner");
    // An unnamed tab reads the terminal in view, never its number (mobile nav phase 2).
    await expect(header.getByRole("heading", { name: "split-w2", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toContainText("2/3");
    await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toHaveAccessibleName(
      /tab 2 of 3$/,
    );
    const panes = page.getByRole("navigation", { name: "Panes in this tab" });
    await panes.getByRole("button", { name: "Next pane" }).click();
    await expect(page.locator(`[data-terminal="${twoBeside}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(header.getByRole("heading", { name: "split-w2b", exact: true })).toBeVisible();
    const tabSwitch = page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });
    await expect(tabSwitch).toContainText("2/3");

    await tabSwitch.click();
    await opened(page.getByRole("dialog", { name: "Switch" }));
    const web = page.getByRole("dialog", { name: "Switch" }).getByRole("region", { name: "web" });
    // One row per tab, each unnamed one read by the terminal it opens; the split tab's row opens the pane in view.
    await expect(tabRows(page, web)).toHaveCount(3);
    await expect(tabRow(web, "split-w1")).toHaveCount(1);
    await expect(tabRow(web, "split-w3")).toHaveCount(1);
    await expect(tabRow(web, "split-w2b")).toHaveAttribute("aria-current", "true");
  });
});
