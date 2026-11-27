import { expect, openNewTerminal, terminalCount, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { holdRunAnswer } from "./run-answer.ts";

test.use({ serviceWorkers: "block" });

test("a terminal ended before its run answers gets no tab when the answer comes, so no tab waits for it (#2913)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const link = await routeHcSocket(page);
  await page.goto("/");
  // The run's answer is held, and so are layout writes, which keeps adoption's (shown once saved) off the screen: the new
  // terminal is shown alone, in no space, while it is ended.
  const answering = holdRunAnswer(link);
  const writing = link.hold("doc.set");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  const running = (await terminalCount(page)).before;

  await page.getByRole("button", { name: /^Session actions for / }).click();
  await page.getByRole("menuitem", { name: "End session…" }).click();
  await page.getByRole("dialog", { name: /^End / }).getByRole("button", { name: "End session" }).click();
  await expect(page.getByRole("contentinfo")).toContainText(`${running - 1} terminal`, { timeout: 15_000 });

  // What the page writes from here on is the run answer's placement, and the next terminal's.
  const sentBefore = link.sent().length;
  answering();
  writing();
  // Answers come in order: once the next terminal's tab is placed in its space, the ended one's answer has been read.
  await openNewTerminal(page);
  const space = page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .locator('button[aria-current="true"]:not([data-machine-header])');
  // An adoption written while it still ran may be saved after it ended: that tab goes as its end is reported again.
  await expect(space.getByLabel(/^\d+ tabs$/)).toHaveText("1");

  const wroteEnded = link
    .sent()
    .slice(sentBefore)
    .filter((frame) => frame.includes('"method":"doc.set"') && frame.includes(`"terminal":"${address}"`));
  expect(wroteEnded).toEqual([]);
  await expect(page.getByText("Waiting for this terminal to start…")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(1);
});
