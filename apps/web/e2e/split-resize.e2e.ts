import type { Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { expect, test, terminalCount } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { fractionOf, paneOf, renameTab, savedTab, seedLayout, type Fraction, type SeedTab } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { chordFor, focusChord } from "./platform-keys.ts";

test.use({ serviceWorkers: "block" });

type Platform = "mac" | "other";

/** The pane keys these tests press, by what they do: the platform's chord for each comes from the app's keymap. */
type Key = "grow" | "equalize" | "zoom" | "close" | "up" | "splitDown";
const ACTIONS: Readonly<Record<Key, string>> = {
  grow: "pane.resize:down",
  equalize: "pane.equalize",
  zoom: "pane.zoom",
  close: "pane.close",
  up: "pane.go:up",
  splitDown: "pane.split:down",
};
// Focus up is Ghostty's chord (⌘⌥↑, Ctrl+Alt+↑), not herdr-app's Alt+K bound to it first.
const keyOn = (platform: Platform, key: Key): string =>
  key === "up" ? focusChord(platform, "up") : chordFor(platform, ACTIONS[key]);

/** Counts the Web Animations a pane frame (a tab panel's own child) plays, in the root element's data-pane-motion. */
const COUNT_PANE_MOTION = `{
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    if (this.parentElement?.getAttribute("role") === "tabpanel") {
      const root = document.documentElement;
      root.dataset.paneMotion = String(Number(root.dataset.paneMotion ?? "0") + 1);
    }
    return animate.apply(this, args);
  };
}`;

const paneMotion = (page: Page): Promise<number> =>
  page.evaluate(() => Number(document.documentElement.dataset["paneMotion"] ?? "0"));

const keyboardAddress = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null);

const shells: string[] = [];
test.afterEach(() => {
  for (const address of shells.splice(0)) {
    try {
      hcOn("host", ["kill", address]);
    } catch (error) {
      // A test that closed its pane ended that shell already (#409); any other failure stands.
      if (!(error instanceof Error && error.message.includes('"kind":"not_found"'))) throw error;
    }
  }
});

const shell = (name: string): string => {
  const address = startShell("host", `resize-${name}`);
  shells.push(address);
  return address;
};

/** one | (two / (three | (four / five))), what herdr-app writes for ⌘D ⌘⇧D ⌘D ⌘⇧D. */
function deepTab(t: readonly string[]): SeedTab {
  const [t1 = "", t2 = "", t3 = "", t4 = "", t5 = ""] = t;
  return {
    id: "tb-deep",
    name: "deep",
    root: [
      { pane: "p1", terminal: t1, weight: 0.5 },
      {
        id: "s-col",
        axis: "column",
        weight: 0.5,
        children: [
          { pane: "p2", terminal: t2, weight: 0.5 },
          {
            id: "s-row",
            axis: "row",
            weight: 0.5,
            children: [
              { pane: "p3", terminal: t3 },
              {
                id: "s-deep",
                axis: "column",
                children: [
                  { pane: "p4", terminal: t4 },
                  { pane: "p5", terminal: t5 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const near = (a: Fraction, b: Partial<Fraction>, tolerance = 0.03): boolean =>
  (["x", "y", "w", "h"] as const).every((key) => b[key] === undefined || Math.abs(a[key] - (b[key] ?? 0)) <= tolerance);

async function expectAt(page: Page, address: string, want: Partial<Fraction>): Promise<void> {
  await expect
    .poll(
      async () => {
        const actual = await fractionOf(page, address).catch(() => null);
        return actual !== null && near(actual, want) ? "ok" : JSON.stringify(actual);
      },
      { timeout: 15_000 },
    )
    .toBe("ok");
}

/** Waits for one resize step of a pane in s-deep: its height moved that way by about a step of the column. */
async function expectStep(page: Page, address: string, from: number, sign: 1 | -1): Promise<void> {
  await expect
    .poll(
      async () => {
        const moved = sign * ((await fractionOf(page, address)).h - from);
        // A step is a twentieth of s-deep, half the panel: 0.025 of it, less the gap.
        return moved >= 0.015 && moved <= 0.04 ? "ok" : `moved ${moved.toFixed(3)}`;
      },
      { timeout: 15_000 },
    )
    .toBe("ok");
}

async function setPlatform(page: Page, platform: Platform): Promise<void> {
  await page.addInitScript(
    (value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }),
    platform === "mac" ? "MacIntel" : "Linux x86_64",
  );
}

for (const platform of ["mac", "other"] as const) {
  test(`${platform}: a deep divider resizes by drag, by its arrow keys and by the resize keys; equalize evens it; sizes outlive a reload; zoom fills the tab`, async ({
    page,
  }) => {
    const t = ["1", "2", "3", "4", "5"].map(shell);
    const [, , , four = "", five = ""] = t;
    seedLayout([deepTab(t)]);
    await setPlatform(page, platform);
    await page.addInitScript(COUNT_PANE_MOTION);
    await page.goto("/");
    await expectAt(page, four, { y: 0.5, h: 0.25 });

    const divider = page.locator('[role="separator"][data-container="s-deep"]');
    await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
    // The line reaches as far as a resize goes, each side keeping MIN_SHARE of the column: 5 to 95.
    await expect(divider).toHaveAttribute("aria-valuemin", "5");
    await expect(divider).toHaveAttribute("aria-valuemax", "95");
    await expect(divider).toHaveAttribute("aria-valuenow", "50");
    const [line, panel] = [await divider.boundingBox(), await page.locator('[role="tabpanel"]:visible').boundingBox()];
    if (line === null || panel === null) throw new Error("no divider or panel box");
    const [x, y] = [line.x + line.width / 2, line.y + line.height / 2];

    // The line losing the pointer mid-drag (it unmounted, or the OS took the pointer) ends the drag where it began.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + panel.height * 0.1, { steps: 4 });
    await expectAt(page, four, { h: 0.35 });
    await divider.dispatchEvent("lostpointercapture");
    await expectAt(page, four, { h: 0.25 });
    await page.mouse.up();

    const saved = savedTab("tb-deep");
    await page.evaluate(() => {
      document.documentElement.dataset["paneMotion"] = "0";
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + panel.height * 0.1, { steps: 8 });
    await page.mouse.up();
    await expectAt(page, four, { h: 0.35 });
    await expectAt(page, five, { y: 0.85, h: 0.15 });
    // Once the page shows a later write it has drawn the drag's own: no pane moved with motion, during or after it.
    await expect.poll(() => savedTab("tb-deep"), { timeout: 15_000 }).not.toBe(saved);
    renameTab("tb-deep", "deep resized");
    await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab", { name: /deep resized/ })).toBeVisible();
    await expectAt(page, four, { h: 0.35 });
    expect(await paneMotion(page)).toBe(0);

    await page.reload();
    await expectAt(page, four, { h: 0.35 });

    await divider.focus();
    const dragged = (await fractionOf(page, four)).h;
    await page.keyboard.press("ArrowUp");
    await expectStep(page, four, dragged, -1);

    await paneOf(page, four).getByRole("textbox").focus();
    const stepped = (await fractionOf(page, four)).h;
    await page.keyboard.press(keyOn(platform, "grow"));
    await expectStep(page, four, stepped, 1);

    await page.keyboard.press(keyOn(platform, "equalize"));
    await expectAt(page, four, { y: 0.5, h: 0.25 });
    await expectAt(page, five, { y: 0.75, h: 0.25 });

    await page.keyboard.press(keyOn(platform, "zoom"));
    await expectAt(page, four, { x: 0, y: 0, w: 1, h: 1 });
    await expect(paneOf(page, five)).toBeHidden();
    await page.keyboard.press(keyOn(platform, "zoom"));
    await expectAt(page, five, { y: 0.75, h: 0.25 });
  });
}

test("closing a pane in the middle gives its space to its neighbour and focus to the pane before; the last closes the tab", async ({
  page,
}) => {
  await setPlatform(page, "other");
  const t = ["1", "2", "3", "4", "5"].map(shell);
  const [one = "", two = "", three = "", four = "", five = ""] = t;
  const other = shell("other");
  seedLayout([deepTab(t), { id: "tb-other", name: "other", root: [{ pane: "p6", terminal: other }] }]);
  await page.goto("/");
  await expectAt(page, three, { x: 0.5, y: 0.5, w: 0.25 });
  const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  await expect(tabs).toHaveCount(2);

  await paneOf(page, two).getByRole("textbox").focus();
  await paneOf(page, three).getByRole("textbox").focus();
  await paneOf(page, three).getByRole("button", { name: "Close pane" }).click();
  await expect(paneOf(page, three)).toHaveCount(0);
  // The column of four and five takes three's place, the whole bottom right.
  await expectAt(page, four, { x: 0.5, y: 0.5, w: 0.5, h: 0.25 });
  await expectAt(page, five, { x: 0.5, y: 0.75, w: 0.5, h: 0.25 });
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toHaveAttribute("data-terminal", two);
  // Saved, three's row is gone: the column of four and five takes its place and the size it had.
  await expect
    .poll(() => savedTab("tb-deep"), { timeout: 15_000 })
    .toBe("tb-deep(p1@0.5,s-col@0.5(p2@0.5,s-deep@0.5(p4,p5)))");

  await [two, four, five, one].reduce<Promise<void>>(async (previous, address) => {
    await previous;
    await paneOf(page, address).getByRole("textbox").focus();
    await page.keyboard.press(keyOn("other", "close"));
    await expect(paneOf(page, address)).toHaveCount(0);
  }, Promise.resolve());
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText(/other/);
});

test("a pane whose program ends while its layout write is refused stays, says so, and keeps focus", async ({
  page,
}) => {
  const [one = "", two = ""] = ["left", "right"].map(shell);
  seedLayout([
    {
      id: "tb-pair",
      name: "pair",
      root: [
        { pane: "p1", terminal: one, weight: 0.5 },
        { pane: "p2", terminal: two, weight: 0.5 },
      ],
    },
  ]);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  // Focus goes through both panes, so `two` has `one` before it to hand focus back to (the first pane may hold focus
  // from the load already, and focusing it again fires nothing).
  await paneOf(page, two).getByRole("textbox").focus();
  await paneOf(page, one).getByRole("textbox").focus();
  await expect(focused).toHaveAttribute("data-terminal", one);
  await paneOf(page, two).getByRole("textbox").focus();
  await expect(focused).toHaveAttribute("data-terminal", two);
  const saved = savedTab("tb-pair");

  // A program that exits drops its pane with no question asked, so nothing but the drop moves focus.
  socket.staleWrites(true);
  await page.keyboard.type("exit\r");
  await expect(page.getByText("The layout was not saved")).toBeVisible({ timeout: 15_000 });
  await expectRefusedAsConflict(page);
  // The layout kept the pane, which now says its session ended; focus stays on it, not on the pane before it.
  const kept = page.getByRole("region", { name: "resize-right terminal" });
  await expect(kept.getByRole("heading", { name: "This session ended" })).toBeVisible();
  await expect(kept).toHaveAttribute("data-focused", "true");
  await expect(page.getByRole("region", { name: "resize-left terminal" })).toHaveAttribute("data-focused", "false");
  expect(savedTab("tb-pair")).toBe(saved);
});

/** Two one-pane tabs, `other` first, with the second, `solo`, in view and its pane focused; returns their shells. */
async function soloInView(page: Page): Promise<{ solo: string; other: string }> {
  const [other = "", solo = ""] = ["other", "solo"].map(shell);
  seedLayout([
    { id: "tb-other", name: "other", root: [{ pane: "p1", terminal: other, weight: 1 }] },
    { id: "tb-solo", name: "solo", root: [{ pane: "p2", terminal: solo, weight: 1 }] },
  ]);
  await page.goto("/");
  await page.getByRole("tab", { name: /solo/ }).click();
  await paneOf(page, solo).getByRole("textbox").focus();
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toHaveAttribute("data-terminal", solo);
  return { solo, other };
}

test("the last pane of the tab in view ending while its layout write is refused keeps that tab in view, focused", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  await soloInView(page);
  const saved = savedTab("tb-solo");

  socket.staleWrites(true);
  await page.keyboard.type("exit\r");
  await expect(page.getByText("The layout was not saved")).toBeVisible({ timeout: 15_000 });
  await expectRefusedAsConflict(page);
  // The tab switch was part of the drop: the refused write puts the tab back in view, with focus on the pane it kept.
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/solo/);
  const kept = page.getByRole("region", { name: "resize-solo terminal" });
  await expect(kept.getByRole("heading", { name: "This session ended" })).toBeVisible();
  await expect(kept).toHaveAttribute("data-focused", "true");
  expect(savedTab("tb-solo")).toBe(saved);
});

/**
 * The notice is the refused write's own: the layout kept changing. A write that never went out (the layout reported as
 * unable to take changes, #2436) shows the same title with another reason, and must not pass as the refusal.
 */
async function expectRefusedAsConflict(page: Page): Promise<void> {
  await expect(
    page.getByText("The layout kept changing on another device, so this change was not saved").first(),
  ).toBeVisible();
}

/**
 * How many "The layout was not saved" notices the page has shown from now on, closed ones included: a notice closes
 * itself after five seconds, which a loaded runner can outlast between the refusal and a spec's last check (#1328).
 */
async function notSavedNotices(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    let shown = 0;
    Reflect.set(window, "__notSavedNotices", () => shown);
    new MutationObserver((records) => {
      for (const node of records.flatMap((record) => [...record.addedNodes]))
        if (node instanceof Element)
          shown += [node, ...node.querySelectorAll("*")].filter(
            (element) => element.childElementCount === 0 && element.textContent === "The layout was not saved",
          ).length;
    }).observe(document.body, { subtree: true, childList: true });
  });
  return () =>
    page.evaluate(() => {
      const read: unknown = Reflect.get(window, "__notSavedNotices");
      return typeof read === "function" ? Number(read()) : Number.NaN;
    });
}

test("closing the tab in view while its layout write is refused keeps that tab in view, and says so once", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  const { solo } = await soloInView(page);
  const saved = savedTab("tb-solo");
  const said = await notSavedNotices(page);
  const { before } = await terminalCount(page);
  /** Whether hc has answered the page's terminal.get for the closed session with not_found (the dead-pane check). */
  const toldGone = (): boolean => {
    const asks = socket
      .sent()
      .filter((text) => text.includes('"method":"terminal.get"') && text.includes(`"terminal":"${solo}"`));
    const ids = asks.flatMap((text) => /"id":(\d+)/.exec(text)?.[1] ?? []);
    return socket
      .received()
      .some(
        (text) =>
          text.includes("not_found") && ids.some((id) => text.includes(`"id":${id},`) || text.includes(`"id":${id}}`)),
      );
  };

  // Closing ends the session and removes it (#409). The feed's word that it is gone waits until the drop its end asked
  // for has been refused, so the removal reaches the page after it, in a known order.
  socket.staleWrites(true);
  const release = socket.holdFromHost('"method":"event"', '"method":"heartbeat"', '"method":"missed"');
  await page.getByRole("button", { name: /^Close .*solo/ }).click();
  await expect.poll(said, { timeout: 15_000 }).toBe(1);
  await expect(page.getByRole("region", { name: "resize-solo terminal" })).toHaveCount(1);

  // The removal is the same ending: the dead-pane check finds the session gone, and the pane is not dropped again, so
  // nothing more is refused or said and the tab stays in view.
  release();
  await expect(page.getByRole("contentinfo")).toContainText(`${before - 1} terminal`, { timeout: 15_000 });
  await expect.poll(toldGone, { timeout: 15_000 }).toBe(true);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/solo/);
  expect(await said()).toBe(1);
  expect(savedTab("tb-solo")).toBe(saved);
});

/** A tab of the given panes side by side, each a shell named for its pane; returns the shells in order. */
function sideBySide(id: string, names: readonly string[]): string[] {
  const started = names.map(shell);
  seedLayout([
    {
      id,
      name: id,
      root: started.map((terminal, index) => ({ pane: `p${index + 1}`, terminal, weight: 1 / started.length })),
    },
  ]);
  return started;
}

/** Focuses each pane in turn, so the last is the focused one and the others are its focus history, oldest first. */
async function focusInTurn(page: Page, addresses: readonly string[]): Promise<void> {
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await addresses.reduce<Promise<void>>(async (previous, address) => {
    await previous;
    await paneOf(page, address).getByRole("textbox").focus();
    await expect(focused).toHaveAttribute("data-terminal", address);
  }, Promise.resolve());
}

test("a background pane whose program ends while its layout write is refused leaves focus where it is", async ({
  page,
}) => {
  const [left = "", right = ""] = sideBySide("tb-pair", ["left", "right"]);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  await focusInTurn(page, [right, left]);
  const saved = savedTab("tb-pair");

  socket.staleWrites(true);
  hcOn("host", ["kill", right]);
  await expect(page.getByText("The layout was not saved")).toBeVisible({ timeout: 15_000 });
  await expectRefusedAsConflict(page);
  // The page undoes a refused drop as soon as the refusal arrives; a later update from the core renders after that.
  hcOn("host", ["label", left, "herdr.name=after-the-refusal"]);
  await expect(page.locator('[data-focused="true"]')).toHaveAttribute("aria-label", "after-the-refusal terminal", {
    timeout: 15_000,
  });
  expect(savedTab("tb-pair")).toBe(saved);
});

test("a pane a refused write kept goes back to its place in the focus history, not to its end", async ({ page }) => {
  const [a = "", b = "", c = ""] = sideBySide("tb-three", ["a", "b", "c"]);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  // Focus history c, b, a: closing a hands focus to b, the pane focused before it.
  await focusInTurn(page, [c, b, a]);

  socket.staleWrites(true);
  hcOn("host", ["kill", c]);
  await expect(page.getByText("The layout was not saved")).toBeVisible({ timeout: 15_000 });
  await expectRefusedAsConflict(page);
  socket.staleWrites(false);
  await paneOf(page, a).getByRole("textbox").focus();
  await page.keyboard.type("exit\r");
  await expect(paneOf(page, a)).toHaveCount(0, { timeout: 15_000 });
  // Kept at the end of the history instead, c would be the pane before a, and focus would land on its ended session.
  await expect(page.locator('[data-focused="true"]')).toHaveAttribute("aria-label", "resize-b terminal");
});

test("zoomed, moving focus or splitting shows every pane again, so a close acts on a pane in view", async ({
  page,
}) => {
  await setPlatform(page, "other");
  const t = ["1", "2", "3", "4", "5"].map(shell);
  const [, two = "", , four = "", five = ""] = t;
  seedLayout([deepTab(t)]);
  await page.goto("/");
  await expectAt(page, four, { y: 0.5, h: 0.25 });
  const focused = page.locator('[data-focused="true"] [data-terminal]');

  await paneOf(page, four).getByRole("textbox").focus();
  await page.keyboard.press(keyOn("other", "zoom"));
  await expect(paneOf(page, five)).toBeHidden();
  await page.keyboard.press(keyOn("other", "up"));
  await expect(focused).toHaveAttribute("data-terminal", two);
  await expect(paneOf(page, two)).toBeVisible();
  await expect(paneOf(page, five)).toBeVisible();
  await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(two);
  await page.keyboard.press(keyOn("other", "close"));
  await expect(paneOf(page, two)).toHaveCount(0);
  await expect(paneOf(page, four)).toBeVisible();

  await paneOf(page, four).getByRole("textbox").focus();
  await page.keyboard.press(keyOn("other", "zoom"));
  await expect(paneOf(page, five)).toBeHidden();
  await page.keyboard.press(keyOn("other", "splitDown"));
  await expect(focused).not.toHaveAttribute("data-terminal", four, { timeout: 15_000 });
  const made = (await focused.getAttribute("data-terminal")) ?? "";
  if (made !== "") shells.push(made);
  await expect(paneOf(page, made)).toBeVisible();
  await expect(paneOf(page, five)).toBeVisible();
});

test("in a left/right split made with Cmd+D, a dialog's button over the pane divider takes the click (#321)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const first = startShell("host", "resize-321");
  seedLayout([{ id: "tb-321", name: "split", root: [{ pane: "p1", terminal: first }] }]);
  await setPlatform(page, "mac");
  await page.goto("/");
  await expect(paneOf(page, first)).toContainText("$", { timeout: 15_000 });
  await paneOf(page, first).getByRole("textbox").focus();
  await page.keyboard.press(chordFor("mac", "pane.split:right"));
  const panes = page.locator("[data-terminal]");
  await expect(panes).toHaveCount(2, { timeout: 15_000 });
  const second =
    (await panes.evaluateAll((all) => all.map((each) => each.getAttribute("data-terminal") ?? ""))).find(
      (address) => address !== first,
    ) ?? "";
  await page
    .getByRole("button", { name: /^Session actions for / })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "End session…" }).click();
  const ask = page.getByRole("dialog", { name: /^End / });
  const end = ask.getByRole("button", { name: "End session" });
  // The case of #321: the part of the button that lies over the divider between the two panes takes the click.
  const button = await end.boundingBox();
  const leftBox = await paneOf(page, first).boundingBox();
  const rightBox = await paneOf(page, second).boundingBox();
  if (button === null || leftBox === null || rightBox === null) throw new Error("no button or pane box");
  const x = (leftBox.x + leftBox.width + rightBox.x) / 2;
  expect(x > button.x + 2 && x < button.x + button.width - 2).toBe(true);
  await end.click({ position: { x: x - button.x, y: button.height / 2 }, timeout: 5_000 });
  await expect(ask).toHaveCount(0);
  await expect(panes).toHaveCount(1, { timeout: 15_000 });
  const kept = await panes.getAttribute("data-terminal");
  if (kept !== null) hcOn("host", ["kill", kept]);
});
