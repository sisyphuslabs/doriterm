import { join } from "node:path";
import { endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const AGENT = join(import.meta.dirname, "fake-todo-agent.ts");
const started: string[] = [];

function start(name: string, argv: readonly string[]): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", "space=todo673", "--", ...argv]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  const address = String(parsed.address);
  started.push(address);
  return address;
}

test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

test("an agent row shows its own todo list's progress as it moves, and nothing once there is no list (#673)", async ({
  page,
}) => {
  const agent = start("todo673-agent", ["bun", AGENT]);
  start("todo673-shell", ["sh", "-c", "exec sleep 600"]);
  await page.goto("/");
  const agents = page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Agents" });
  const row = agents.getByRole("button").filter({ hasText: "todo673-agent" });
  const progress = row.getByRole("img", { name: /tasks done$/ });

  // Two of four tasks done, read from the list under Claude Code's spinner.
  await expect(progress).toHaveText("2/4", { timeout: 20_000 });
  await expect(progress).toHaveAccessibleName("2 of 4 tasks done");

  // Twelve tasks, five shown done and the rest folded into one line.
  hcOn("host", ["keys", agent, "n"]);
  await expect(progress).toHaveText("5/12");

  // The turn is over with every task done: the count line over the list.
  hcOn("host", ["keys", agent, "n"]);
  await expect(progress).toHaveText("3/3");

  // No list on the screen: no progress on the row.
  hcOn("host", ["keys", agent, "n"]);
  await expect(progress).toHaveCount(0);

  // A program that reports nothing draws no list: its row never shows progress.
  const shell = agents.getByRole("button").filter({ hasText: "todo673-shell" });
  await expect(shell).toHaveCount(1);
  await expect(shell.getByRole("img", { name: /tasks done$/ })).toHaveCount(0);
});

test("an omp row shows the phases of its TODO list added up (#673)", async ({ page }) => {
  start("todo673-omp", ["bun", AGENT, "omp"]);
  await page.goto("/");
  const agents = page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Agents" });
  const progress = agents
    .getByRole("button")
    .filter({ hasText: "todo673-omp" })
    .getByRole("img", { name: /tasks done$/ });
  await expect(progress).toHaveText("1/4", { timeout: 20_000 });
  await expect(progress).toHaveAccessibleName("1 of 4 tasks done");
});
