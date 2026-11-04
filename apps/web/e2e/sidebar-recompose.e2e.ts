import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { hcOn } from "./machine-switch.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const SPACE = "rc206";
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const group = (page: Page, title: string) => sidebar(page).getByRole("region", { name: title, exact: true });
const count = (region: Locator) => region.locator(":scope > header [data-numeric]");

let dir = "";

/** The terminals the added machine's own core lists, by its bare address (`t5`). */
function onMachine(): string[] {
  const listed: unknown = JSON.parse(hcOn("machine", ["ls", "--json"]));
  const terminals: unknown = typeof listed === "object" && listed !== null ? Reflect.get(listed, "terminals") : [];
  return Array.isArray(terminals)
    ? terminals.flatMap((terminal: unknown) => {
        const address: unknown =
          typeof terminal === "object" && terminal !== null ? Reflect.get(terminal, "address") : null;
        return typeof address === "string" ? [address] : [];
      })
    : [];
}
const started: string[] = [];

/** An agent that reports `first`, then `then` once its flip file appears: hc's state changes while the page is open. */
function startFlipping(name: string, first: string, then: string): { address: string; flip: () => void } {
  const flag = join(dir, name);
  const script = [
    `printf '\\033]7501;state=${first}\\033\\\\'`,
    `while [ ! -e '${flag}' ]; do sleep 0.1; done`,
    `printf '\\033]7501;state=${then}\\033\\\\'`,
    "exec sleep 600",
  ].join("; ");
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${SPACE}`, "--", "sh", "-c", script]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  const address = String(parsed.address);
  started.push(address);
  return { address, flip: () => writeFileSync(flag, "") };
}

test.beforeAll(() => {
  dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "rc206-"));
});
test.afterAll(() => {
  try {
    for (const address of started) endAgent("host", address);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the agents group comes first, and its status groups and counts follow hc's state live", async ({ page }) => {
  const agent = startFlipping("rc-flip", "working", "done");
  await page.goto("/");
  const lists = sidebar(page).locator("[data-roving-lists] > div > section");
  await expect(lists.first()).toHaveAccessibleName("Agents", { timeout: 20_000 });
  const working = group(page, "Working");
  const done = group(page, "Done");
  await expect(rows(working).filter({ hasText: "rc-flip" })).toBeVisible({ timeout: 20_000 });
  const doneBefore = (await done.count()) === 0 ? 0 : Number(await count(done).textContent());
  agent.flip();
  await expect(rows(done).filter({ hasText: "rc-flip" })).toBeVisible({ timeout: 15_000 });
  await expect(rows(working).filter({ hasText: "rc-flip" })).toHaveCount(0);
  await expect(count(done)).toHaveText(String(doneBefore + 1));
});

test("sort by space groups the agents under their space, and the choice survives a reload", async ({ page }) => {
  startFlipping("rc-sort", "blocked", "blocked");
  await page.goto("/");
  await expect(rows(group(page, "Needs you")).filter({ hasText: "rc-sort" })).toBeVisible({ timeout: 20_000 });
  await sidebar(page).getByRole("button", { name: "Sort agents" }).click();
  await page.getByRole("menuitemradio", { name: "By space" }).click();
  await expect(rows(group(page, SPACE)).filter({ hasText: "rc-sort" })).toBeVisible();
  await page.reload();
  await expect(rows(group(page, SPACE)).filter({ hasText: "rc-sort" })).toBeVisible({ timeout: 20_000 });
  await sidebar(page).getByRole("button", { name: "Sort agents" }).click();
  await page.getByRole("menuitemradio", { name: "By status" }).click();
  await expect(rows(group(page, "Needs you")).filter({ hasText: "rc-sort" })).toBeVisible();
});

test("hover shows only Pin and More; a pin lifts the agent into Pinned, in hc, across a reload", async ({ page }) => {
  const { address } = startFlipping("rc-pin", "working", "working");
  await page.goto("/");
  const row = rows(group(page, "Working")).filter({ hasText: "rc-pin" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const pin = sidebar(page).getByRole("button", { name: "Pin rc-pin" });
  const more = sidebar(page).getByRole("button", { name: "More for rc-pin" });
  await expect(pin).toBeHidden();
  await row.hover();
  await expect(pin).toBeVisible();
  await expect(more).toBeVisible();
  await expect(row.locator("..").getByRole("button")).toHaveCount(3);
  await pin.click();
  await expect(rows(group(page, "Pinned")).filter({ hasText: "rc-pin" })).toBeVisible();
  await expect.poll(() => hcOn("host", ["get", address, "--json"])).toContain('"herdr.pinned"');
  await page.reload();
  await expect(rows(group(page, "Pinned")).filter({ hasText: "rc-pin" })).toBeVisible({ timeout: 20_000 });
  await rows(group(page, "Pinned")).filter({ hasText: "rc-pin" }).hover();
  await sidebar(page).getByRole("button", { name: "Unpin rc-pin" }).click();
  await expect(rows(group(page, "Working")).filter({ hasText: "rc-pin" })).toBeVisible();
});

test("with a second machine known, spaces sit under machine rows that start a new space there", async ({ page }) => {
  await page.goto("/");
  const spaces = group(page, "Spaces");
  const remote = spaces.getByRole("region", { name: MACHINE_NAME, exact: true });
  await expect(remote).toBeVisible({ timeout: 20_000 });
  await expect(sidebar(page).getByRole("region", { name: "Machines", exact: true })).toHaveCount(0);
  const newSpace = remote.getByRole("button", { name: `New space on ${MACHINE_NAME}` });
  const before = new Set(onMachine());
  try {
    await remote.locator(`[data-machine-header]`).hover();
    await newSpace.click();
    const focused = page.locator('[data-focused="true"] [data-terminal]');
    await expect(focused).toHaveAttribute("data-terminal", new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`), {
      timeout: 20_000,
    });
  } finally {
    // The shell it started ends on the machine's own core, here and even on failure, so no later spec meets its tab.
    for (const id of onMachine().filter((one) => !before.has(one))) {
      hcOn("machine", ["kill", id]);
      hcOn("machine", ["rm", id]);
    }
  }
});

test("the footer holds Settings and Add machine", async ({ page }) => {
  await page.goto("/");
  const footer = sidebar(page).locator('[data-slot="sidebar-footer"]');
  await footer.getByRole("button", { name: "Add machine" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await footer.getByRole("link", { name: /^Settings/ }).click();
  await expect(page).toHaveURL(/\/settings/);
});

test("dragging the edge narrow makes the icon rail; dragging back restores a full sidebar", async ({ page }) => {
  startFlipping("rc-rail", "working", "working");
  await page.goto("/");
  const aside = sidebar(page);
  const edge = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(rows(group(page, "Working")).filter({ hasText: "rc-rail" })).toBeVisible({ timeout: 20_000 });
  const box = await edge.boundingBox();
  if (box === null) throw new Error("no sidebar edge");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(100, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(44);
  await expect(aside.getByRole("button", { name: "rc-rail, Working" })).toBeVisible();
  const railEdge = await edge.boundingBox();
  if (railEdge === null) throw new Error("no rail edge");
  await page.mouse.move(railEdge.x + railEdge.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(320, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await aside.boundingBox())?.width ?? 0)).toBeGreaterThan(300);
  await expect(rows(group(page, "Working")).filter({ hasText: "rc-rail" })).toBeVisible();
});

test("keyboard: the edge toggles the rail with Enter and steps with arrows; a row's actions follow it", async ({
  page,
}) => {
  startFlipping("rc-keys", "working", "working");
  await page.goto("/");
  const aside = sidebar(page);
  const row = rows(group(page, "Working")).filter({ hasText: "rc-keys" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.focus();
  await page.keyboard.press("ArrowRight");
  await expect(aside.getByRole("button", { name: "Pin rc-keys" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(aside.getByRole("button", { name: "More for rc-keys" })).toBeFocused();
  const edge = page.getByRole("separator", { name: "Resize sidebar" });
  await edge.focus();
  const wide = Number(await edge.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowRight");
  await expect(edge).toHaveAttribute("aria-valuenow", String(wide + 16));
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(44);
  await page.keyboard.press("Enter");
  await expect(edge).toHaveAttribute("aria-valuenow", String(wide + 16));
  await page.keyboard.press("ArrowLeft");
});

test("the sidebar's width eases, and under reduced motion it changes without a transition", async ({ page }) => {
  const widthEase = () =>
    sidebar(page).evaluate((element) => {
      const style = getComputedStyle(element);
      const at = style.transitionProperty
        .split(",")
        .map((part) => part.trim())
        .indexOf("width");
      return at === -1 ? 0 : Number.parseFloat(style.transitionDuration.split(",")[at] ?? "0");
    });
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible({ timeout: 20_000 });
  expect(await widthEase()).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await widthEase()).toBe(0);
});
