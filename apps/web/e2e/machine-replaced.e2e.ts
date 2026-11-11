import type { Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { DEMO_MACHINE, MACHINE_ENV, MACHINE_NAME, viaCommand } from "./machine.ts";
import { hcOn, STATE_BOUND_MS } from "./machine-switch.ts";
import { getCoreDoc, machineCore } from "./core-doc.ts";
import { readSavedEnv } from "./saved-env.ts";
import { selectedPane } from "./tab-strip.ts";

// The mesh reconciler replaces a machine added earlier for a member's core (over ssh, or with a via) with its mesh line
// (#710): `machine.rm` of the old entry, then `machine.add` of the line for the same core, under the member's mesh name.
// These specs make that swap with hc on the e2e host's core and check that a page with the machine's tab open loses
// nothing: the tab stays (at the new name if it changed), the terminal answers, and the machine's layout is the same.

const MESH_NAME = "build-mesh";

function vias(): { readonly first: string; readonly replacement: string } {
  const first = viaCommand(readSavedEnv(MACHINE_ENV).env, DEMO_MACHINE);
  return { first, replacement: `env DORIFACE_MESH_LINE=1 ${first}` };
}

function replaceWithLine(name: string): void {
  hcOn("host", ["machine", "rm", MACHINE_NAME]);
  hcOn("host", ["machine", "add", "--via", vias().replacement, "--name", name]);
}

test.describe("a machine replaced by its mesh line, with its terminal open", () => {
  let remote = "";
  let current = MACHINE_NAME;
  test.beforeEach(() => {
    remote = startShell("machine", "e2e");
  });
  test.afterEach(() => {
    hcOn("host", ["machine", "rm", current]);
    hcOn("host", ["machine", "add", "--via", vias().first, "--name", MACHINE_NAME]);
    current = MACHINE_NAME;
    endAgent("machine", remote);
  });

  async function openRemote(page: Page): Promise<number> {
    await page.goto("/");
    await agentRow(page, "e2e", true).click();
    const terminal = selectedPane(page, `${MACHINE_NAME}/${remote}`);
    await expect(terminal).toBeVisible({ timeout: 20_000 });
    return page.getByRole("tablist", { name: "Tabs" }).getByRole("tab").count();
  }

  for (const name of [MACHINE_NAME, MESH_NAME]) {
    test(`keeps its tab, layout and terminal when the line lands as ${name === MACHINE_NAME ? "the same name" : "another name"}`, async ({
      page,
    }) => {
      const open = await openRemote(page);
      const id = machineCore(MACHINE_NAME);
      await expect.poll(() => getCoreDoc("herdr-app", MACHINE_NAME), { timeout: STATE_BOUND_MS }).not.toBeNull();
      const layout = getCoreDoc("herdr-app", MACHINE_NAME);

      replaceWithLine(name);
      current = name;
      expect(machineCore(name)).toBe(id);

      const moved = selectedPane(page, `${name}/${remote}`);
      await expect(moved).toBeVisible({ timeout: STATE_BOUND_MS });
      await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(open);
      await moved.click();
      await page.keyboard.type("echo replaced-$((40 + 2))\r");
      await expect(moved).toContainText("replaced-42", { timeout: 15_000 });
      expect(getCoreDoc("herdr-app", name)).toEqual(layout);

      await page.reload();
      await expect(selectedPane(page, `${name}/${remote}`)).toBeVisible({ timeout: STATE_BOUND_MS });
    });
  }
});
