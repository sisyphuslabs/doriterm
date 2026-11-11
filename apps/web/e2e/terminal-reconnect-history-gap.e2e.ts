import { execFileSync } from "node:child_process";
import { endAgent } from "./agents.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";

test.use({ serviceWorkers: "block" });

const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

/** The core's own screen of a terminal, read with hc: what the program printed, whether or not the page has it. */
function coreScreen(address: string): string {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" });
}

/**
 * hc's attach has no cursor to resume from, so a reattach repaints the screen alone (#1997): what scrolled off the core's
 * screen while the line was down never reaches the view. Until the core can resume (herdrdev/herdr-core#233), the status
 * bar says so after the reconnect, beside the connection status and outside the terminal, until it is dismissed (#2033).
 */
test("after a reconnect the status bar says output from while the line was down may be missing (#2033)", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  opened.push(address);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("for i in $(seq 1 200); do echo kept-$i; done");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("kept-200", { timeout: 30_000 });
  const note = page.getByRole("status").filter({ hasText: "Output from while disconnected may be missing" });
  // A first attach has nothing missing: no note.
  await expect(note).toHaveCount(0);

  // The line goes down, and while it is down the program prints far more than a screen.
  await page.keyboard.type("sleep 1; for i in $(seq 1 400); do echo away-$i; done");
  await page.keyboard.press("Enter");
  await link.drop(true);
  await expect.poll(() => coreScreen(address), { timeout: 30_000 }).toContain("away-400");
  link.restore();
  // Output after the reattach comes behind its repaint on the same stream: once it shows, the repaint has been drawn.
  await page.keyboard.type("echo back-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("back-2", { timeout: 30_000 });

  // The note is in the status bar, not over the terminal, and it stays until it is dismissed.
  await expect(note).toBeVisible();
  await expect(terminal.getByRole("status")).toHaveCount(0);
  await note.getByRole("button", { name: "Dismiss" }).click();
  await expect(note).toHaveCount(0);
});
