// A notice's own rows (#669), on #192's fake Claude Code agent: a row that does not decline opens the app and the page
// answers, the agent's No row answers from the notification; either sends the agent's own key only while its dialog is
// on the live screen.
import type { Page } from "@playwright/test";
import { type AskingAgent, startAskingAgent } from "./approval-agent.ts";
import { expect, test } from "./fixtures.ts";
import { deliverPush, type Posted, serviceWorker, shownNotifications, tapNotification } from "./push.ts";
import { pushSuite, turnOn } from "./push-suite.ts";

const suite = pushSuite();

function asking(name: string, scenario: "permission" | "question" | "steps" = "permission"): AskingAgent {
  const agent = startAskingAgent(name, scenario);
  suite.endAfterTest(() => agent.end());
  return agent;
}

const banner = (page: Page) => page.locator("[data-prompt-answer]");

test("a permission notice is opaque; its Yes row opens the pane and the page answers once, with the agent's own key", async ({
  page,
  context,
}, info) => {
  await turnOn(page);
  const agent = asking("push-ask-9d4");
  const posted: Posted = await suite.service().next();
  expect(posted.notice).toEqual({
    v: 1,
    n: expect.stringMatching(/^[\w-]{22}$/),
    k: "permission",
    h: expect.any(String),
  });
  const wire = JSON.stringify(posted.headers) + Buffer.from(posted.body).toString("latin1");
  for (const plain of ["push-ask-9d4", "touch probe-a.txt", "claude-code"]) expect(wire).not.toContain(plain);

  const worker = await serviceWorker(context);
  const tag = String(posted.notice["n"]);
  await deliverPush(context, JSON.stringify(posted.notice));
  await expect
    .poll(() => shownNotifications(worker), { timeout: 15_000 })
    .toEqual([
      {
        title: "doriface",
        body: "An agent is asking for permission.",
        tag,
        actions: ["option:1", "option:4:declines"],
      },
    ]);
  await tapNotification(worker, tag, "option:1");
  await expect(page.locator(`[data-terminal="${agent.address}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(banner(page)).toHaveAttribute("data-prompt-answer", "answered", { timeout: 15_000 });
  await expect.poll(() => agent.keys()).toEqual(["1"]);
  await page.screenshot({ path: info.outputPath("allow-answered.png") });

  // The same notice again: the prompt is answered, so nothing is typed and the banner says so.
  await banner(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await deliverPush(context, JSON.stringify(posted.notice));
  await tapNotification(worker, tag, "option:1");
  await expect(banner(page)).toHaveAttribute("data-prompt-answer", "stale", { timeout: 15_000 });
  await page.screenshot({ path: info.outputPath("allow-stale.png") });
  expect(agent.keys()).toEqual(["1"]);
});

test("a prompt answered in the terminal first is stale: its Yes row opens the pane, says so, and sends nothing", async ({
  page,
  context,
}) => {
  await turnOn(page);
  const agent = asking("push-stale-3b1");
  const posted = await suite.service().next();
  agent.typeInTerminal("x");
  await expect.poll(() => agent.keys()).toEqual(["x"]);
  const worker = await serviceWorker(context);
  await deliverPush(context, JSON.stringify(posted.notice));
  await tapNotification(worker, String(posted.notice["n"]), "option:1");
  await expect(banner(page)).toHaveAttribute("data-prompt-answer", "stale", { timeout: 15_000 });
  await expect(page.locator(`[data-terminal="${agent.address}"]`)).toBeVisible();
  expect(agent.keys()).toEqual(["x"]);
});

test("a question's notice offers its own rows; a row opens the pane and the page answers with that row's key (#669)", async ({
  page,
  context,
}) => {
  await turnOn(page);
  const agent = asking("push-question-7c4", "question");
  const posted = await suite.service().next();
  expect(posted.notice).toMatchObject({ k: "input" });
  const wire = JSON.stringify(posted.headers) + Buffer.from(posted.body).toString("latin1");
  for (const plain of ["Postgres", "SQLite", "Which database"]) expect(wire).not.toContain(plain);

  const worker = await serviceWorker(context);
  const tag = String(posted.notice["n"]);
  await deliverPush(context, JSON.stringify(posted.notice));
  // The rows come over the E2EE push stream, never in the payload; Chromium shows two actions.
  await expect
    .poll(() => shownNotifications(worker), { timeout: 15_000 })
    .toEqual([
      { title: "doriface", body: "An agent is waiting for your input.", tag, actions: ["option:1", "option:2"] },
    ]);
  await tapNotification(worker, tag, "option:2");
  await expect(page.locator(`[data-terminal="${agent.address}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(banner(page)).toHaveAttribute("data-prompt-answer", "answered", { timeout: 15_000 });
  await expect.poll(() => agent.keys()).toEqual(["2"]);
});

test("several questions in a row offer no rows: a tap opens the card (#669)", async ({ page, context }) => {
  await turnOn(page);
  asking("push-steps-2e8", "steps");
  const posted = await suite.service().next();
  const worker = await serviceWorker(context);
  const tag = String(posted.notice["n"]);
  await deliverPush(context, JSON.stringify(posted.notice));
  await expect
    .poll(() => shownNotifications(worker), { timeout: 15_000 })
    .toEqual([{ title: "doriface", body: "An agent is waiting for your input.", tag, actions: [] }]);
});

test("the agent's No row answers from the notification with its own key, without opening the app", async ({
  page,
  context,
}) => {
  await turnOn(page);
  const agent = asking("push-deny-6e2");
  const posted = await suite.service().next();
  const worker = await serviceWorker(context);
  await deliverPush(context, JSON.stringify(posted.notice));
  await tapNotification(worker, String(posted.notice["n"]), "option:4:declines");
  await expect.poll(() => agent.keys()).toEqual(["4"]);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(banner(page)).toHaveCount(0);
});
