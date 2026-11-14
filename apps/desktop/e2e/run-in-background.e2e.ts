// Keep running in the background (#1500): with it on, closing the window leaves the app and this computer's host
// running (on a Mac with no Dock icon), so the phone stays connected; opening the app again brings the window back, and
// the choice holds across launches. With it off, closing the window does what it always did.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import electronBinary from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DorifaceBridge } from "../src/shared/bridge.ts";
import { scratchHcSession } from "./hc-session.ts";
import { appArgs, launchOptions, packagedExecutable } from "./launch.ts";

declare global {
  interface Window {
    readonly doriface?: DorifaceBridge;
  }
}

const SWITCH = "Keep running in the background";
const mac = process.platform === "darwin";

let hc: ReturnType<typeof scratchHcSession> | undefined;
let profile = "";
let env: Record<string, string> = {};

test.beforeAll(() => {
  hc = scratchHcSession();
  profile = mkdtempSync(join(tmpdir(), "dd-background-"));
  env = Object.fromEntries(
    Object.entries({ ...process.env, ...hc.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

test.afterAll(async () => {
  try {
    await hc?.dispose();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

const profileArg = (): string => `--user-data-dir=${profile}`;
const launch = async (): Promise<ElectronApplication> => electron.launch(await launchOptions([profileArg()], { env }));
const windowCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const dockVisible = (app: ElectronApplication): Promise<boolean | null> =>
  app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible() ?? null);

/** `URL.origin` is "null" for the app: scheme, so the origin is rebuilt from its parts. */
const originOf = (page: Page): string => {
  const url = new URL(page.url());
  return `${url.protocol}//${url.host}`;
};

async function settings(app: ElectronApplication): Promise<Page> {
  const page = app.windows().find((candidate) => !candidate.isClosed()) ?? (await app.firstWindow());
  await page.waitForSelector("#root > *");
  await page.goto(`${originOf(page)}/settings`);
  return page;
}

/** Opens a socket to the host the app started, as the page does: the host answering it is the host still serving. */
async function hostAnswers(endpoint: { readonly url: string; readonly token: string }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(endpoint.url, ["doriface.v1", `doriface.token.${endpoint.token}`]);
    socket.addEventListener("open", () => {
      resolve(socket.protocol);
      socket.close();
    });
    socket.addEventListener("error", () => reject(new Error(`could not open ${endpoint.url}`)));
  });
}

test("on, closing the window keeps the app and its host running, a launch brings the window back, and it holds across launches", async () => {
  const app = await launch();
  try {
    const page = await settings(app);
    const toggle = page.getByRole("switch", { name: SWITCH });
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    expect(JSON.parse(readFileSync(join(profile, "run-in-background.json"), "utf8"))).toEqual({ enabled: true });

    const endpoint = await page.evaluate(async () => {
      const answer = await window.doriface?.startLocalHost();
      if (answer === undefined || "failure" in answer) throw new Error("the local host did not start");
      return answer;
    });
    await page.evaluate(() => window.doriface?.closeWindow());
    await expect.poll(() => windowCount(app)).toBe(0);
    if (mac) expect(await dockVisible(app)).toBe(false);
    // The app is still there to answer, and so is its host, with no window left.
    expect(await hostAnswers(endpoint)).toBe("doriface.v1");

    // Opening the app again: a second launch on Windows and Linux, the Dock's reopen (activate) on a Mac.
    if (mac) await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
    else {
      const second = spawn(packagedExecutable ?? String(electronBinary), appArgs([profileArg()]), {
        env,
        stdio: "ignore",
      });
      expect(await new Promise<number | null>((resolve) => second.once("exit", resolve))).toBe(0);
    }
    await expect.poll(() => windowCount(app)).toBe(1);
    if (mac) await expect.poll(() => dockVisible(app)).toBe(true);
    expect(await hostAnswers(endpoint)).toBe("doriface.v1");
  } finally {
    await app.close();
  }

  const relaunched = await launch();
  try {
    const page = await settings(relaunched);
    await expect(page.getByRole("switch", { name: SWITCH })).toBeChecked();
    await page.screenshot({ path: test.info().outputPath("run-in-background.png") });
  } finally {
    await relaunched.close();
  }
});

test("off again, closing the window does what it always did: a Mac keeps the app in the Dock, Windows and Linux quit", async () => {
  const app = await launch();
  let exited = false;
  app.process().once("exit", () => (exited = true));
  try {
    const page = await settings(app);
    const toggle = page.getByRole("switch", { name: SWITCH });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    expect(JSON.parse(readFileSync(join(profile, "run-in-background.json"), "utf8"))).toEqual({ enabled: false });
    const closed = new Promise<void>((resolve) => app.once("close", () => resolve()));
    await page.evaluate(() => window.doriface?.closeWindow());
    if (mac) {
      await expect.poll(() => windowCount(app)).toBe(0);
      expect(await dockVisible(app)).toBe(true);
    } else {
      await closed;
      expect(exited).toBe(true);
    }
  } finally {
    if (!exited) await app.close();
  }
});
