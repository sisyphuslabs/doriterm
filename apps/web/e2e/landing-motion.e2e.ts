import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, type Locator, type Page, test } from "@playwright/test";

// #1179: the landing's motion toggle pauses every loop on the page, the spinners in the hero's live mockups included.
// Those mockups are iframes on the landing's own vite server, so this spec serves apps/landing itself.
test.describe.configure({ mode: "serial" });
// The landing's vite compiles each mockup (React and the app's stylesheet) on its first request.
test.setTimeout(180_000);

const LANDING = join(import.meta.dirname, "..", "..", "landing");
let server: ChildProcess | undefined;
let origin = "";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject()));
    });
  });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  // Playwright sets FORCE_COLOR for its workers; vite would colour the line this waits for.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  server = spawn("bunx", ["--bun", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: LANDING,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...inherited, NO_COLOR: "1" },
  });
  if (server.stdout === null) throw new Error("the landing's vite has no stdout");
  for await (const line of createInterface({ input: server.stdout })) if (line.includes(`${origin}/`)) return;
  throw new Error("the landing's vite ended before it listened");
});

test.afterAll(async () => {
  const running = server;
  if (running === undefined) return;
  running.kill("SIGTERM");
  await expect.poll(() => running.exitCode ?? running.signalCode, { timeout: 30_000 }).not.toBeNull();
});

/**
 * The play state of every animation in both hero mockups, once each has drawn. The desktop window's working agents draw
 * spinners; the phone's terminal has none today, but anything that starts animating there is held to the same toggle.
 */
async function expectPlayState(page: Page, state: "paused" | "running"): Promise<void> {
  const desktop = page.frameLocator(".app-desktop iframe");
  const spinners = desktop.locator('[data-slot="spinner"]');
  await expect(spinners.first()).toBeAttached({ timeout: 30_000 });
  await Promise.all((await spinners.all()).map((spinner) => expect(spinner).toHaveCSS("animation-play-state", state)));
  const phone = page.frameLocator(".app-phone iframe").locator("#root > *");
  await expect(phone).toBeAttached({ timeout: 30_000 });
  const others = (root: Locator) => () =>
    root.evaluate(
      (element, wanted) =>
        [...element.ownerDocument.querySelectorAll("*")]
          .map((node) => getComputedStyle(node))
          .filter((style) => style.animationName !== "none" && style.animationPlayState !== wanted)
          .map((style) => `${style.animationName} ${style.animationPlayState}`),
      state,
    );
  await Promise.all([desktop.locator("body"), phone].map((root) => expect.poll(others(root)).toEqual([])));
}

test("pausing motion pauses the spinners in the hero's live mockups, and a reload keeps them paused", async ({
  page,
}) => {
  // Wide enough that both the desktop window and the phone are laid out (the desktop window hides on phones).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(origin);
  await expectPlayState(page, "running");

  const toggle = page.locator("[data-motion-toggle]");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expectPlayState(page, "paused");

  // The pause is remembered: frames that load after it start paused.
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expectPlayState(page, "paused");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expectPlayState(page, "running");
});
