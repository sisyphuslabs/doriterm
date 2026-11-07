import { expect, openNewTerminal, terminalCount, test, pressNewTab } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";

test.use({ serviceWorkers: "block" });

/** The answer to terminal.run: the started terminal, address first. */
const RUN_ANSWER = '"result":{"address"';

// A run's answer can reach the page after the person has moved on: the terminal is listed and shown, then a menu is
// opened, then the answer lands (#360). Placing the terminal and handing it the held keys must not take the keyboard
// from what the person opened since.
test("a run that answers after a menu was opened leaves the keyboard in the menu", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  const answers = (): number => link.received().filter((frame) => frame.includes(RUN_ANSWER)).length;
  const answersBefore = answers();
  const releaseAnswer = link.holdFromHost(RUN_ANSWER);
  const count = await terminalCount(page);
  await pressNewTab(page.getByRole("button", { name: "New tab" }).first());
  // The core started it and the feed lists it; the page has not heard the run's answer.
  await count.grown();
  expect(answers()).toBe(answersBefore);

  await page.getByRole("button", { name: "Session actions" }).click();
  const rename = page.getByRole("menuitem", { name: "Rename…" });
  await expect(rename).toBeVisible();
  const writes = (): number => link.sent().filter((frame) => frame.includes('"method":"doc.set"')).length;
  const writesBefore = writes();

  releaseAnswer();
  // The answer places the terminal (a layout write) and hands it the held keys; its view mounts in its tab and starts.
  await expect.poll(writes, { timeout: 15_000 }).toBeGreaterThan(writesBefore);
  const address = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[data-terminal]")].map((el) => el.getAttribute("data-terminal") ?? "");
    // hc numbers terminals t1 ... t19, t1b, t1c ... (digits, then letters in order): a longer id is newer, and ids of
    // one length order as text. Number("1b") is NaN, so a numeric sort picks any of them once a core passes t19.
    return ids.toSorted((a, b) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0))[0] ?? "";
  });
  await expect(page.locator(`[data-terminal="${address}"][data-ready="true"]`).first()).toContainText("$", {
    timeout: 15_000,
  });
  await expect(page.locator("[data-type-ahead]")).toHaveAttribute("inert", "");

  await expect(rename).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest("[data-terminal]") === null)).toBe(true);
});

// New tab's menu hands the keyboard back once its closing animation ends; a menu opened before then owns it, and the
// closing one must not take it back (#1014). The animation is slowed so the second menu reliably opens inside it.
test("a menu opened while New tab's menu is still closing keeps the keyboard once that menu is gone (#1014)", async ({
  page,
}) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  await openNewTerminal(page);
  await page.addStyleTag({
    content: "[data-ending-style] { transition-duration: 1500ms !important; animation-duration: 1500ms !important; }",
  });
  // The run's answer is held, so the keyboard stays in the box that holds what is typed for the new terminal.
  const releaseAnswer = link.holdFromHost(RUN_ANSWER);
  await pressNewTab(page.getByRole("button", { name: "New tab" }).first());
  const closing = page.getByRole("menuitem", { name: /^Terminal/ });
  await page.getByRole("button", { name: "Session actions" }).click();
  const rename = page.getByRole("menuitem", { name: "Rename…" });
  await expect(rename).toBeVisible();
  await expect(closing).toHaveCount(0, { timeout: 5_000 });
  await expect(rename).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.closest('[role="menu"]')?.textContent ?? "")).toContain(
    "Rename…",
  );
  releaseAnswer();
});
