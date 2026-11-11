// A pane is "shown" to the host only while the person can read it: the workspace under Settings is not, so a notice
// about its focused pane still comes (#1024). The agent works first and finishes on a key, so the page has told the
// host which pane it shows before the agent's turn ends: the order a slow host could otherwise only sometimes see.
import { expect, test } from "./fixtures.ts";
import { finishingAgent, press, pushSuite, turnOn } from "./push-suite.ts";

const suite = pushSuite();

/** The `focus` lines a push-stream frame carries, read as the host reads them: one JSON object a line. */
function focusLines(frame: string): (string | null)[] {
  const found: (string | null)[] = [];
  for (const line of frame.split("\n")) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // Not a push line: the websocket carries other frames too.
    }
    if (typeof message !== "object" || message === null || Reflect.get(message, "t") !== "focus") continue;
    const terminal: unknown = Reflect.get(message, "terminal");
    found.push(typeof terminal === "string" ? terminal : null);
  }
  return found;
}

test("a pane behind the Settings dialog is not shown: its agent's notice still comes (#1024)", async ({ page }) => {
  const sentFocus: (string | null)[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      sentFocus.push(...focusLines(typeof payload === "string" ? payload : payload.toString("utf8")));
    });
  });
  await turnOn(page);
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  const address = finishingAgent("push-behind-settings-4c2", suite.endAfterTest);
  // The workspace behind the dialog opens the agent's terminal as its focused pane.
  await expect(page.locator(`[data-focused="true"] [data-terminal="${address}"]`)).toHaveCount(1, { timeout: 15_000 });
  const before = suite.service().posted.length;
  press(address);
  await expect
    .poll(
      () =>
        suite
          .service()
          .posted.slice(before)
          .map((posted) => posted.notice["k"]),
      { timeout: 15_000 },
    )
    .toEqual(["done"]);
  // Whichever reached the host first, the page never told it that a pane under Settings is the one being read.
  expect(sentFocus.filter((terminal) => terminal !== null)).toEqual([]);
  // The same capture hears the pane once Settings closes, so the check above could have caught a focus line.
  await page.getByRole("button", { name: "Close settings" }).first().click();
  await expect.poll(() => sentFocus, { timeout: 15_000 }).toContain(address);
});
