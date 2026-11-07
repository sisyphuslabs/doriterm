// A pane is "shown" to the host only while the person can read it: the workspace under Settings is not, so a notice
// about its focused pane still comes (#1024). The agent works first and finishes on a key, so the page has told the
// host which pane it shows before the agent's turn ends: the order a slow host could otherwise only sometimes see.
import { expect, test } from "./fixtures.ts";
import { finishingAgent, press, pushSuite, turnOn } from "./push-suite.ts";

const suite = pushSuite();

test("a pane behind the Settings dialog is not shown: its agent's notice still comes (#1024)", async ({ page }) => {
  const sentFocus: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("latin1");
      const found = /"t":"focus","terminal":("[^"]*"|null)/.exec(text);
      if (found !== null) sentFocus.push(found[1] ?? "");
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
  expect(sentFocus.filter((terminal) => terminal !== "null")).toEqual([]);
});
