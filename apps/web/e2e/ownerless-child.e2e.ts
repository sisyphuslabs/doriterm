// A sub-agent outlives the agent that started it (#2990): once that parent ends, the sub-agent stays in the Agents list
// as a top-level row marked ownerless, at once and without a reload, and it opens, takes input and ends like any other.
import { AGENT_SHELL, agentRow } from "./agents.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

test.use({ serviceWorkers: "block" });

endOwnTerminals();

const OWNERLESS = "Ownerless: the agent that started it has ended";

/** An agent stand-in on this core; a child is started as the Doriterm skill starts one (`--outlive-parent`). */
function startAgentShell(name: string, parent?: string): string {
  const from = parent === undefined ? [] : ["--parent", parent, "--outlive-parent"];
  const out = hcOn("host", ["run", "--bg", ...from, "--name", name, "--label", "space=lanes", "--", ...AGENT_SHELL]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  const address = String(started.address);
  hcOn("host", ["send", address, `printf '\\033]7501;state=working\\033\\\\'`]);
  return address;
}

const stateOf = (address: string): unknown =>
  Reflect.get(Object(JSON.parse(hcOn("host", ["get", address, "--json"]))), "state");

test("a sub-agent whose parent ends runs on ownerless: listed on its own, usable and closable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openNewTerminal(page);
  const lead = startAgentShell("lead-2990");
  const worker = startAgentShell("worker-2990", lead);
  const row = agentRow(page, "worker-2990", false);
  await expect(row.locator("[data-tree-guides]")).toHaveAttribute("data-depth", "1", { timeout: 20_000 });
  await expect(row.getByRole("img", { name: OWNERLESS })).toHaveCount(0);

  hcOn("host", ["kill", lead]);
  await expect(row.getByRole("img", { name: OWNERLESS })).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('[data-tree-guides][data-depth="1"]')).toHaveCount(0);
  expect(stateOf(worker)).toBe("live");

  await row.click();
  const pane = page.locator(`[data-terminal="${worker}"]`);
  await expect(pane).toBeVisible({ timeout: 20_000 });
  await pane.getByRole("textbox").focus();
  await page.keyboard.type("echo still-$((2990+1))");
  await page.keyboard.press("Enter");
  await expect.poll(() => hcOn("host", ["read", worker, "--lines", "40"]), { timeout: 15_000 }).toContain("still-2991");

  await page.getByRole("button", { name: /^Session actions for / }).click();
  await page.getByRole("menuitem", { name: "End session…" }).click();
  await page.getByRole("dialog", { name: /^End / }).getByRole("button", { name: "End session" }).click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
});
