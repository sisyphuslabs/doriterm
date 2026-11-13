// A question about a session (Close, End, Rename) whose session ends while it is open says so in place, with one OK,
// instead of closing itself with nothing on screen saying why (#200). Ending the session from the question says nothing more.
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { setConfirmClose } from "./close-confirm.ts";
import { holdFrames } from "./hold-frames.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

function hc(...args: string[]): string {
  const { hc: bin, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(bin, args, { env: { ...process.env, ...env }, encoding: "utf8" });
}

/** Records every "<name> already ended" dialog title the page renders, however briefly. */
async function recordEndedTitles(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { endedTitles: seen });
    new MutationObserver(() => {
      for (const node of document.querySelectorAll("[role='dialog'] h2, [role='alertdialog'] h2")) {
        const text = node.textContent ?? "";
        if (text.endsWith("already ended") && !seen.includes(text)) seen.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

/**
 * A new shell is titled by its argv (/bin/sh) until its process name (bash on macOS, sh elsewhere) arrives, then falls back to
 * its argv: waiting for the name first makes the name each question asks with known.
 */
const NAME = process.platform === "darwin" ? "bash" : "sh";
const named = (page: Page) =>
  expect(page.locator('[data-focused="true"]')).toHaveAttribute("aria-label", `${NAME} terminal`, { timeout: 15_000 });

/** The dialog titled exactly `name`: a substring match would take "/bin/sh already ended" for "sh already ended". */
const dialog = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });
/** The statement is an alertdialog, so a screen reader reads its name and text out as it opens. */
const statement = (page: Page) => page.getByRole("alertdialog", { name: `${NAME} already ended`, exact: true });

/** The address of the terminal whose input holds DOM focus, read from document.activeElement. */
const focusedAddress = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement
      ? (active.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null)
      : null;
  });

/** The session actions sit in the tab strip beside Split and act on the focused terminal. */
async function sessionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("Cmd+W's question whose session ends under it says the session ended, and only OK closes it", async ({ page }) => {
  const socket = await routeHcSocket(page);
  // A shell at its prompt closes without a question unless confirm-close-surface asks every time.
  await setConfirmClose(page, "always");
  const remaining = (await (await openNewTerminal(page)).getAttribute("data-terminal")) ?? "";
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const { before } = await terminalCount(page);
  await named(page);

  await terminal.getByRole("textbox").focus();
  await pressShortcut(page, "tab.close");
  const ask = dialog(page, `Close ${NAME}?`);
  await expect(ask).toBeVisible();

  // The feed's word that the terminal finished waits, so the session ends under the open question in a known order:
  // its stream closes first (the tab goes), then the feed lists it as gone. The whole feed waits, not that one event:
  // closing the tab writes the layout document, and the feed drops an event older than that write's once it has seen it.
  const release = socket.holdFromHost('"method":"event"', '"method":"heartbeat"', '"method":"missed"');
  hc("kill", address);
  await expect(page.locator(`[data-terminal="${address}"]`)).toHaveCount(0, { timeout: 15_000 });
  await expect(ask).toBeVisible();
  // Focus belongs in the question; the remaining pane can still take it as it becomes the focused one (#241). Put it
  // back, so only the statement's own return can put it in the remaining terminal.
  await ask.getByRole("button", { name: "Cancel" }).focus();
  release();

  const ended = statement(page);
  await expect(ended).toBeVisible({ timeout: 15_000 });
  await expect(ended).toHaveAccessibleDescription("It ended before you answered, so there is nothing to close.");
  await expect(ended.getByRole("button")).toHaveText(["OK"]);
  await expect(ended.getByRole("button", { name: "OK" })).toBeFocused();

  // OK leaves the keyboard where closing does: in the terminal that is left.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => focusedAddress(page)).toBe(remaining);
  await expect(page.getByRole("contentinfo")).toContainText(`${before - 1} terminal`, { timeout: 15_000 });
});

test("a session renamed while its question is open is still named as the question asked it when it ends", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await named(page);
  await sessionMenu(page, "End session…");
  const ask = dialog(page, `End ${NAME}?`);
  await expect(ask).toBeVisible();

  // Another device renames it: the page has the new name (the pane says so) before the session ends.
  hc("label", address, "herdr.name=renamed-meanwhile");
  await expect(page.locator('[data-focused="true"]')).toHaveAttribute("aria-label", "renamed-meanwhile terminal", {
    timeout: 15_000,
  });
  await expect(ask).toBeVisible();

  hc("kill", address);
  await expect(statement(page)).toBeVisible({ timeout: 15_000 });
});

for (const [item, question] of [
  ["End session…", `End ${NAME}?`],
  ["Rename…", `Rename ${NAME}`],
] as const) {
  test(`the question "${question}" whose session ends under it says the session ended`, async ({ page }) => {
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    const address = (await terminal.getAttribute("data-terminal")) ?? "";
    await named(page);
    await sessionMenu(page, item);
    await expect(dialog(page, question)).toBeVisible();

    hc("kill", address);
    const ended = statement(page);
    await expect(ended).toBeVisible({ timeout: 15_000 });
    await expect(ended.getByRole("button")).toHaveText(["OK"]);
    await ended.getByRole("button", { name: "OK" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("the statement that a session ended takes the keyboard before the next frame, so an Escape at once closes it (#2076)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await named(page);
  await sessionMenu(page, "End session…");
  await expect(dialog(page, `End ${NAME}?`)).toBeVisible();

  // A busy page draws late: the statement is on screen before its next frame, and a key pressed then is the statement's.
  const release = await holdFrames(page);
  hc("kill", address);
  const ended = statement(page);
  await expect(ended).toBeVisible({ timeout: 15_000 });
  await expect(ended.getByRole("button", { name: "OK" })).toBeFocused();
  await page.keyboard.press("Escape");
  await release();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("a statement whose only button cannot take focus opens on itself, so the keyboard is never left behind it (#2102)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await named(page);
  await sessionMenu(page, "End session…");
  await expect(dialog(page, `End ${NAME}?`)).toBeVisible();

  // No statement ships a disabled OK today; this one gets it disabled as it is inserted, before the dialog picks where
  // focus goes (mutation records are delivered before that choice, which waits for the layout effects).
  await page.evaluate(() => {
    new MutationObserver(() => {
      for (const button of document.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button"))
        button.disabled = true;
    }).observe(document.body, { subtree: true, childList: true });
  });
  hc("kill", address);
  const ended = statement(page);
  await expect(ended).toBeVisible({ timeout: 15_000 });
  await expect(ended.getByRole("button", { name: "OK" })).toBeDisabled();
  await expect(ended).toBeFocused();
});

test("a session menu closed with only a toast up gives focus back to its trigger (#2380)", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  // A toast is a dialog that is not modal: what is on the page while it shows still takes focus back.
  await page.evaluate(() => {
    const toast = document.createElement("div");
    toast.setAttribute("role", "dialog");
    toast.setAttribute("aria-modal", "false");
    toast.textContent = "A toast";
    document.body.append(toast);
  });
  const trigger = page.getByRole("button", { name: "Session actions" });
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("a session menu still closing when its session ends gives no focus back behind the statement (#2362)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  await named(page);
  // A busy page can still be closing the menu when the session ends: its pane, and the menu with it, then go after the
  // statement has taken the keyboard. A long exit holds the menu up so that order happens every time. It is an animation,
  // not a transition: a transition starts from the opacity the menu has, and a menu still fading in (from 0) has next to
  // none to fade out, so the exit was over at once now and then and the menu went before the session ended.
  await page.addStyleTag({
    content:
      "@keyframes hold-menu-exit { from { opacity: 1; } to { opacity: 0; } } [role='menu'][data-ending-style] { animation: hold-menu-exit 10s linear !important; }",
  });
  await sessionMenu(page, "End session…");
  await expect(dialog(page, `End ${NAME}?`)).toBeVisible();
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(1);

  hc("kill", address);
  const ended = statement(page);
  await expect(ended).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  await expect(ended.getByRole("button", { name: "OK" })).toBeFocused();
});

test("closing from Cmd+W's question ends the session with no notice that it ended", async ({ page }) => {
  await recordEndedTitles(page);
  await setConfirmClose(page, "always");
  await openNewTerminal(page);
  const terminal = await openNewTerminal(page);
  const { before } = await terminalCount(page);

  await terminal.getByRole("textbox").focus();
  await pressShortcut(page, "tab.close");
  const ask = page.getByRole("dialog", { name: /^Close .+\?$/ });
  await ask.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Once the feed has the session gone, nothing it could have said about the ending is still to come.
  await expect(page.getByRole("contentinfo")).toContainText(`${before - 1} terminal`, { timeout: 15_000 });
  expect(await page.evaluate(() => Reflect.get(window, "endedTitles"))).toEqual([]);
});
