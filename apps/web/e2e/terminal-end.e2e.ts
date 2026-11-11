import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

function hc(args: readonly string[]): string {
  const { hc: bin, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(bin, args, { env: { ...process.env, ...env }, encoding: "utf8" });
}

/** The pid of the program running in the terminal, or null while a kept terminal waits for its new shell. */
function pidOf(address: string): number | null {
  const terminal: unknown = JSON.parse(hc(["get", address, "--json"]));
  if (typeof terminal !== "object" || terminal === null || !("pid" in terminal)) return null;
  return typeof terminal.pid === "number" ? terminal.pid : null;
}

test("a kept terminal whose program is lost keeps its tab and attaches to the restarted shell", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  const tabsBefore = await tabs.count();
  hc(["keep", address]);
  const pid = (): unknown => JSON.parse(hc(["get", address, "--json"])).pid;
  const shellPid = pid();

  // SIGKILL leaves no exit code, so the core counts the shell as lost and restarts it in place.
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("kill -9 $$");
  await page.keyboard.press("Enter");
  await expect.poll(pid, { timeout: 30_000 }).not.toBe(shellPid);

  await expect(tabs).toHaveCount(tabsBefore);
  // The restarted shell's view is a new one: the lost shell's screen, with the kill, is gone from it.
  const restarted = page.locator(`[data-terminal="${address}"]`);
  await expect(restarted).not.toContainText("kill -9", { timeout: 15_000 });
  await expect(restarted).toContainText("$", { timeout: 15_000 });
  await restarted.getByRole("textbox").focus();
  await page.keyboard.type("echo back-$((2+3))");
  await page.keyboard.press("Enter");
  await expect(restarted).toContainText("back-5", { timeout: 15_000 });
});

test("keys typed offline for a kept program that is lost and restarted meanwhile do not run in the new shell", async ({
  page,
}) => {
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  hc(["keep", address]);
  const shellPid = pidOf(address);
  if (shellPid === null) throw new Error(`${address} has no program`);
  // Marks this view, so the fresh one the restarted program gets is told apart from it.
  await terminal.evaluate((element) => element.setAttribute("data-before-restart", ""));
  await terminal.getByRole("textbox").focus();

  await socket.drop(true);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  const misdelivered = test.info().outputPath("misdelivered.txt");
  await page.keyboard.type(`echo misdeliv-$((5*5)) > '${misdelivered}'`);
  await page.keyboard.press("Enter");
  process.kill(shellPid, "SIGKILL");
  // Right after the kill the core still reports the killed pid; the restart is the pid changing, then a new one.
  await expect.poll(() => pidOf(address), { timeout: 30_000 }).not.toBe(shellPid);
  await expect.poll(() => pidOf(address), { timeout: 30_000 }).not.toBeNull();
  socket.restore();
  // The keys are dropped either way, and the person is told: by the reattach, which finds another program there, or
  // first by the 10 s bound on what waits for a link that is down, when the restart and the reconnect take longer (#2266).
  const notSent =
    /Typed input was not sent because (the program restarted|this terminal could not be reached for 10 s)/;
  await expect(page.getByText(notSent)).toBeVisible({ timeout: 20_000 });

  const restarted = page.locator(`[data-terminal="${address}"]:not([data-before-restart])`);
  await expect(restarted).toContainText("$", { timeout: 20_000 });
  await restarted.getByRole("textbox").focus();
  await page.keyboard.type("echo fence-$((1+2))");
  await page.keyboard.press("Enter");
  await expect(restarted).toContainText("fence-3", { timeout: 15_000 });
  expect(existsSync(misdelivered)).toBe(false);
});

test("a reconnect inside a kept program's restart shows it restarting, not an error, then attaches", async ({
  page,
}) => {
  // Every attach error the page ever renders, however briefly: the "didn't open" screen, or the older inline wording.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { attachErrors: seen });
    new MutationObserver(() => {
      for (const node of document.querySelectorAll("p, h1, h2, h3, [role='heading']")) {
        const text = node.textContent ?? "";
        const error = text.startsWith("Could not open") || text === "This terminal didn't open";
        if (error && !seen.includes(text)) seen.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  hc(["keep", address]);
  const shellPid = pidOf(address);
  if (shellPid === null) throw new Error(`${address} has no program`);
  await terminal.evaluate((element) => element.setAttribute("data-before-restart", ""));

  await socket.drop(true);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  process.kill(shellPid, "SIGKILL");
  // Lost, waiting for its new shell: the reconnect lands in this window.
  await expect.poll(() => pidOf(address), { timeout: 15_000 }).toBeNull();
  socket.restore();

  const restarted = page.locator(`[data-terminal="${address}"]:not([data-before-restart])`);
  await expect(restarted).toContainText("$", { timeout: 30_000 });
  await restarted.getByRole("textbox").focus();
  await page.keyboard.type("echo back-$((6*7))");
  await page.keyboard.press("Enter");
  await expect(restarted).toContainText("back-42", { timeout: 15_000 });
  expect(await page.evaluate(() => Reflect.get(window, "attachErrors"))).toEqual([]);
});

const NOT_SENT = "Typed input was not sent because the program restarted";

test("when the restarted program's view arrives before the old view's reattach, the queued keys still never run", async ({
  page,
}) => {
  await page.addInitScript((title) => {
    const seen = new WeakSet<Element>();
    Object.assign(window, { notSent: 0 });
    new MutationObserver(() => {
      for (const heading of document.querySelectorAll("h2")) {
        if (heading.textContent !== title || seen.has(heading)) continue;
        seen.add(heading);
        Object.assign(window, { notSent: Number(Reflect.get(window, "notSent")) + 1 });
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, NOT_SENT);
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  hc(["keep", address]);
  const shellPid = pidOf(address);
  if (shellPid === null) throw new Error(`${address} has no program`);
  await terminal.evaluate((element) => element.setAttribute("data-before-restart", ""));
  await terminal.getByRole("textbox").focus();

  await socket.drop(true);
  await expect(page.getByRole("status").filter({ hasText: "Reconnecting" })).toBeVisible();
  const misdelivered = test.info().outputPath("misdelivered.txt");
  // One input event, the way wterm takes a commit: typing it key by key took most of the test's time on a loaded host.
  await page.keyboard.insertText(`echo misdeliv-$((5*5)) > '${misdelivered}'`);
  await page.keyboard.press("Enter");
  process.kill(shellPid, "SIGKILL");
  // Right after the kill the core still reports the killed pid; the restart is the pid changing, then a new one.
  await expect.poll(() => pidOf(address), { timeout: 30_000 }).not.toBe(shellPid);
  await expect.poll(() => pidOf(address), { timeout: 30_000 }).not.toBeNull();

  // Held attaches force the order: the terminal list (with the new pid) replaces the old view before any reply.
  const release = socket.hold("terminal.attach");
  socket.restore();
  const restarted = page.locator(`[data-terminal="${address}"]:not([data-before-restart])`);
  await expect(restarted).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(`[data-terminal="${address}"][data-before-restart]`)).toHaveCount(0);
  await expect(page.getByText(NOT_SENT)).toBeVisible({ timeout: 15_000 });
  release();

  await expect(restarted).toContainText("$", { timeout: 15_000 });
  await restarted.getByRole("textbox").focus();
  await page.keyboard.insertText("echo fence-$((1+2))");
  await page.keyboard.press("Enter");
  await expect(restarted).toContainText("fence-3", { timeout: 15_000 });
  expect(existsSync(misdelivered)).toBe(false);
  // Each notice ever shown, counted as it appears: a toast closes itself after a few seconds, which the steps above can
  // outlast on a loaded host, so the count on screen now says nothing about how many were raised.
  expect(await page.evaluate(() => Reflect.get(window, "notSent"))).toBe(1);
});

test("a kept program that ends while its view waits for the restart closes its tab", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  const tabsBefore = await tabs.count();
  hc(["keep", address]);

  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("kill -9 $$");
  await page.keyboard.press("Enter");
  const restarting = page.getByText("The program in this terminal is restarting");
  await expect(restarting).toBeVisible({ timeout: 15_000 });
  // Ended inside the restart grace: no restarted program will ever replace this view.
  hc(["kill", address]);

  await expect(tabs).toHaveCount(tabsBefore - 1, { timeout: 15_000 });
  await expect(restarting).toHaveCount(0);
});

test("a view that goes away with keys queued says they were not sent, even if the line drops while it asks why", async ({
  page,
}) => {
  // Every not-sent notice the page renders, however briefly.
  await page.addInitScript(() => {
    const seen: string[] = [];
    const counted = new WeakSet<Node>();
    Object.assign(window, { notSent: seen });
    new MutationObserver(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (!counted.has(node) && (node.textContent ?? "").startsWith("Typed input was not sent")) {
          counted.add(node);
          seen.push(node.textContent ?? "");
        }
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const notSent = (): Promise<unknown> => page.evaluate(() => Reflect.get(window, "notSent"));
  const socket = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  const reconnecting = page.getByRole("status").filter({ hasText: "Reconnecting" });

  await socket.drop(true);
  await expect(reconnecting).toBeVisible();
  const queued = test.info().outputPath("queued.txt");
  await page.keyboard.type(`echo queued > '${queued}'`);
  await page.keyboard.press("Enter");
  // The reattach, and the question the view asks the core on its way out, both stay unanswered.
  socket.hold("terminal.attach", "terminal.get");
  const from = socket.sent().length;
  socket.restore();
  await expect(reconnecting).toBeHidden({ timeout: 15_000 });
  const asked = (method: string) =>
    socket
      .sent()
      .slice(from)
      .some((frame) => frame.includes(`"method":"${method}"`));
  await expect.poll(() => asked("terminal.attach"), { timeout: 10_000 }).toBe(true);
  // Crossing the phone breakpoint unmounts the desktop view while its reattach is in flight.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect.poll(() => asked("terminal.get"), { timeout: 10_000 }).toBe(true);
  expect(await notSent()).toEqual([]);

  // The line drops again before the core answers: the input was still never sent, so say so, with no reason.
  await socket.drop(true);
  await expect.poll(notSent, { timeout: 10_000 }).toEqual(["Typed input was not sent"]);
  expect(existsSync(queued)).toBe(false);
});
