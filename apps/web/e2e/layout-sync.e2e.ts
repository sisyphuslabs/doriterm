import type { Browser, Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { getCoreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { LAYOUT_DOC } from "./layout-doc.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

endOwnTerminals();

/** A second device: its own browser context (its own storage, so its own focus and selected tab) on the same host. */
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

/** The tab bar's own Split right: split panes carry one each in their header too, after the strip in the document. */
const splitRight = (page: Page) => page.getByRole("button", { name: "Split right" }).first();
const tabs = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const panesIn = (page: Page, tab: string) =>
  page.locator(
    `[role="tabpanel"][aria-label="${tab}"] [data-terminal], [role="tabpanel"][aria-label="${tab}"] [aria-label="Starting terminal"]`,
  );

test("a split on one device shows on another without a reload, and edits of two tabs at once both stay", async ({
  page,
  browser,
}) => {
  const [one, two] = [startShell("host", "sync-one"), startShell("host", "sync-two")];
  // Written the way herdr-app writes it, with fields doriface does not use: they must come back untouched.
  setCoreDoc(LAYOUT_DOC, {
    spaces: [
      {
        folder: "/tmp",
        id: "spc-sync",
        name: "",
        tabs: [
          {
            id: "tb-one",
            name: "one",
            root: {
              border: { color: "accent", width: 2 },
              children: [{ content: { terminal: one }, id: "p-one", type: "block" }],
              id: "tb-one",
              type: "row",
            },
          },
          {
            id: "tb-two",
            name: "two",
            root: { children: [{ content: { terminal: two }, id: "p-two", type: "block" }], id: "tb-two", type: "row" },
          },
        ],
      },
    ],
  });
  const other = await secondDevice(browser);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await Promise.all([expect(tabs(page)).toHaveCount(2, { timeout: 20_000 }), expect(tabs(other)).toHaveCount(2)]);

  await tabs(page).filter({ hasText: "one" }).click();
  await splitRight(page).click();
  await expect(panesIn(page, "one")).toHaveCount(2, { timeout: 15_000 });
  await expect(panesIn(other, "one")).toHaveCount(2, { timeout: 15_000 });
  // The other device keeps its own selected tab and focus: the split did not move it.
  await expect(tabs(other).first()).toHaveAttribute("aria-selected", "true");

  await tabs(other).filter({ hasText: "two" }).click();
  await Promise.all([splitRight(page).click(), splitRight(other).click()]);
  await Promise.all(
    [page, other].flatMap((device) => [
      expect(panesIn(device, "one")).toHaveCount(3, { timeout: 20_000 }),
      expect(panesIn(device, "two")).toHaveCount(2, { timeout: 20_000 }),
    ]),
  );
  const written = JSON.stringify(getCoreDoc(LAYOUT_DOC));
  expect(written).toContain('"border":{"color":"accent","width":2}');
  expect(written).toContain('"folder":"/tmp"');
  await other.context().close();
});

/** The tab ids of the layout's first space, in the order the host has them. */
function hostOrder(): readonly string[] {
  const doc: unknown = getCoreDoc(LAYOUT_DOC);
  const spaces = typeof doc === "object" && doc !== null && "spaces" in doc ? doc.spaces : undefined;
  const space: unknown = Array.isArray(spaces) ? spaces[0] : undefined;
  const list = typeof space === "object" && space !== null && "tabs" in space ? space.tabs : undefined;
  return Array.isArray(list)
    ? list.map((tab: unknown) => (typeof tab === "object" && tab !== null && "id" in tab ? String(tab.id) : ""))
    : [];
}

test("two devices that move tabs of one space at once both keep their move, and end on the same order (#2005)", async ({
  page,
  browser,
}) => {
  const shells = ["re-a", "re-b", "re-c"].map((name) => startShell("host", name));
  setCoreDoc(LAYOUT_DOC, {
    spaces: [
      {
        folder: "/tmp",
        id: "spc-reorder",
        name: "",
        tabs: shells.map((terminal, at) => {
          const id = `tb-re-${"abc"[at] ?? ""}`;
          return {
            id,
            name: `re-${"abc"[at] ?? ""}`,
            root: { children: [{ content: { terminal }, id: `p-${id}`, type: "block" }], id, type: "row" },
          };
        }),
      },
    ],
  });
  const other = await secondDevice(browser);
  // The first device's write is held, so it goes to the host after the other device's: it names a version the
  // document has left, and the host refuses it as a conflict.
  const socket = await routeHcSocket(page);
  await Promise.all([page.goto("/"), other.goto("/")]);
  await Promise.all([expect(tabs(page)).toHaveCount(3, { timeout: 20_000 }), expect(tabs(other)).toHaveCount(3)]);
  const writes = (): number => socket.sent().filter((frame) => frame.includes('"method":"doc.set"')).length;
  const before = writes();

  const release = socket.hold("doc.set");
  await tabs(page).filter({ hasText: "re-a" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move tab right" }).click();
  await tabs(other).filter({ hasText: "re-c" }).click({ button: "right" });
  await other.getByRole("menuitem", { name: "Move tab left" }).click();
  await expect.poll(hostOrder, { timeout: 15_000 }).toEqual(["tb-re-a", "tb-re-c", "tb-re-b"]);
  release();

  // On the conflict the first device reads the other's order and makes its own move again on it, rather than writing
  // over it (packages/protocol/src/layout/sync.ts): re-a goes one to the right of where it now stands.
  await expect.poll(hostOrder, { timeout: 15_000 }).toEqual(["tb-re-c", "tb-re-a", "tb-re-b"]);
  expect(writes() - before).toBe(2);
  await Promise.all(
    [page, other].map((device) => expect(tabs(device)).toHaveText([/re-c/, /re-a/, /re-b/], { timeout: 15_000 })),
  );
  await other.context().close();
});
