import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TITLEBAR_CONTROLS, TRAFFIC_LIGHTS } from "../src/config/window.ts";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

test.skip(process.platform !== "darwin", "the hidden-inset titlebar and its window buttons exist only on macOS");

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly shellHome: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-titlebar-"));
  const shellHome = mkdtempSync(join(tmpdir(), "dd-titlebar-shell-"));
  writeFileSync(join(shellHome, "clean-shell"), "#!/bin/sh\nexec /bin/sh -i\n", { mode: 0o755 });
  scratch = { hc, profile, shellHome };
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...hc.env,
      SHELL: "clean-shell",
      PATH: `${shellHome}:${process.env["PATH"] ?? ""}`,
      HOME: shellHome,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const args = [`--user-data-dir=${profile}`];
  launched = await electron.launch(await launchOptions(args, { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
      rmSync(scratch.shellHome, { recursive: true, force: true });
    }
  }
});

const running = (): ElectronApplication => {
  if (launched === undefined) throw new Error("the app did not launch");
  return launched;
};

/** Every control and every piece of text drawn where the window buttons sit. */
function underWindowButtons(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ lights, controls }) => {
      const hits: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        const text = element.childElementCount === 0 && (element.textContent ?? "").trim() !== "";
        if (!text && !element.matches(controls)) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === "hidden") continue;
        const overlaps =
          box.left < lights.x + lights.width &&
          lights.x < box.right &&
          box.top < lights.y + lights.height &&
          lights.y < box.bottom;
        if (overlaps)
          hits.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? element.ariaLabel ?? "").trim()}"`);
      }
      return hits;
    },
    { lights: TRAFFIC_LIGHTS, controls: TITLEBAR_CONTROLS },
  );
}

/**
 * herdr-app's gap between the last window button and the first item beside it (its app icon, then the name): 12 pt,
 * measured from its macOS titlebar (#392).
 */
const TITLE_GAP = 12;

/** The left edge of the sidebar's "Doriterm" title against the right edge of the window buttons, in window points. */
async function titleClearance(app: ElectronApplication, page: Page): Promise<number> {
  const title = await page.locator("aside [data-titlebar]").getByText("Doriterm", { exact: true }).boundingBox();
  const buttons = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
  );
  if (title === null || buttons === undefined || buttons === null) throw new Error("no title or no window buttons");
  const zoom = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0,
  );
  return title.x * zoom - (buttons.x + TRAFFIC_LIGHTS.width);
}

const insetVariable = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--titlebar-inset-start").trim());

test("nothing sits under the window buttons, in every state and size, and full screen drops the inset", async () => {
  const app = running();
  const page = await app.firstWindow();
  await page.waitForSelector("#root > *");
  const position = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
  );
  expect(position).toEqual({ x: TRAFFIC_LIGHTS.x, y: TRAFFIC_LIGHTS.y });
  await expect.poll(() => insetVariable(page)).not.toBe("");

  const sizes = [
    { width: 1470, height: 956 },
    { width: 1280, height: 800 },
  ] as const;
  const checkAt = async (state: string, size: (typeof sizes)[number]): Promise<void> => {
    await app.evaluate(
      ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setContentSize(bounds.width, bounds.height),
      size,
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size.width);
    expect(await underWindowButtons(page), `${state} at ${size.width}x${size.height}`).toEqual([]);
  };
  const check = async (state: string): Promise<void> => {
    for (const size of sizes) {
      // oxlint-disable-next-line no-await-in-loop -- one window: each size is applied and read before the next
      await checkAt(state, size);
    }
  };

  await check("first run");
  await page.getByRole("button", { name: "Use this computer" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible({ timeout: 30_000 });
  await check("workspace with the sidebar");
  const header = await page.locator("aside [data-titlebar]").first().boundingBox();
  const buttons = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
  );
  expect(header).not.toBeNull();
  expect(buttons).toBeDefined();
  const headerCentre = (header?.y ?? 0) + (header?.height ?? 0) / 2;
  const buttonsCentre = (buttons?.y ?? 0) + TRAFFIC_LIGHTS.height / 2;
  expect(
    Math.abs(buttonsCentre - headerCentre),
    `buttons centred at ${buttonsCentre}, header at ${headerCentre}`,
  ).toBeLessThanOrEqual(1);
  expect(await titleClearance(app, page), "the title's gap after the window buttons").toBeGreaterThanOrEqual(TITLE_GAP);
  // The text-size keys never shrink the chrome under the window buttons (#388).
  for (const key of ["ControlOrMeta+Minus", "ControlOrMeta+Minus", "ControlOrMeta+Minus", "ControlOrMeta+Equal"]) {
    // oxlint-disable-next-line no-await-in-loop -- one window: each key is pressed and read before the next
    await page.keyboard.press(key);
    // oxlint-disable-next-line no-await-in-loop -- as above
    expect(await titleClearance(app, page), `after ${key}`).toBeGreaterThanOrEqual(TITLE_GAP);
    // oxlint-disable-next-line no-await-in-loop -- as above
    expect(await underWindowButtons(page), `after ${key}`).toEqual([]);
  }
  await page.keyboard.press("ControlOrMeta+0");

  // One sidebar toggle, fixed right after the window buttons and centred on them, open or closed (#415).
  const lightsCentre = TRAFFIC_LIGHTS.y + TRAFFIC_LIGHTS.height / 2;
  const opened = await page.getByRole("button", { name: "Hide sidebar" }).boundingBox();
  if (opened === null) throw new Error("no sidebar toggle with the sidebar open");
  expect(opened.x, "the toggle starts past the window buttons").toBeGreaterThanOrEqual(
    TRAFFIC_LIGHTS.x + TRAFFIC_LIGHTS.width + TITLE_GAP,
  );
  expect(
    Math.abs(opened.y + opened.height / 2 - lightsCentre),
    "toggle centred on the window buttons",
  ).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeHidden();
  const closed = await page.getByRole("button", { name: "Show sidebar" }).boundingBox();
  if (closed === null) throw new Error("no sidebar toggle with the sidebar closed");
  for (const side of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(closed[side] - opened[side]),
      `toggle ${side} open ${opened[side]} vs closed ${closed[side]}`,
    ).toBeLessThanOrEqual(1);
  }
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
  const reopened = await page.getByRole("button", { name: "Hide sidebar" }).boundingBox();
  expect(reopened).toEqual(opened);

  // herdr-app's row: the app icon a title gap after the toggle, the title 11 px after the icon, all centred on the lights.
  const row = await page.evaluate(() => {
    const sidebarRow = document.querySelector("aside [data-titlebar]");
    const icon = sidebarRow?.querySelector("img")?.getBoundingClientRect();
    const title = [...(sidebarRow?.querySelectorAll("span") ?? [])]
      .find((el) => el.textContent === "Doriterm")
      ?.getBoundingClientRect();
    const search = sidebarRow?.querySelector('[aria-label="Command palette"]')?.getBoundingClientRect();
    const name = [...(sidebarRow?.querySelectorAll("span") ?? [])].find((el) => el.textContent === "Doriterm");
    const font = name === undefined ? null : getComputedStyle(name);
    return icon === undefined || title === undefined || search === undefined
      ? null
      : {
          font: { size: font?.fontSize, weight: font?.fontWeight },
          icon: { x: icon.x, right: icon.right, y: icon.y + icon.height / 2 },
          title: { x: title.x, y: title.y + title.height / 2 },
          search: search.y + search.height / 2,
        };
  });
  if (row === null) throw new Error("the sidebar header has no app icon, title or search");
  expect(row.font, "herdr-app's title: 14 px semibold").toEqual({ size: "14px", weight: "600" });
  expect(row.icon.x - (opened.x + opened.width), "toggle to icon").toBeCloseTo(TITLE_GAP, 0);
  expect(row.title.x - row.icon.right, "icon to title").toBeCloseTo(11, 0);
  for (const [what, y] of [
    ["icon", row.icon.y],
    ["title", row.title.y],
    ["search", row.search],
  ] as const) {
    expect(Math.abs(y - lightsCentre), `${what} centred on the window buttons`).toBeLessThanOrEqual(1);
  }

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeHidden();
  await check("workspace with the sidebar hidden");
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page).toHaveURL(/\/settings$/);
  await check("settings");

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit("enter-full-screen"));
  await expect.poll(() => insetVariable(page)).toBe("");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit("leave-full-screen"));
  await expect.poll(() => insetVariable(page)).not.toBe("");
});
