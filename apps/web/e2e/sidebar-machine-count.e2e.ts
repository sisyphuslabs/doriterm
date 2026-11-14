import { devices } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateOn } from "./ended-terminal.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { rows } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];

let dir = "";
const started: string[] = [];

/** A program that only waits, started straight on the e2e core in `cwd`; with `parent`, as that terminal's sub-agent. */
function start(name: string, cwd: string, parent?: string): string {
  const from = parent === undefined ? [] : ["--parent", parent];
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, ...from, "--", "sh", "-c", "exec sleep 600"]);
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== "object" || parsed === null || !("address" in parsed)) throw new Error(out);
  const address = String(parsed.address);
  started.push(address);
  return address;
}

/** Ends a terminal's program and waits until the core says it is over: `hc kill` returns once it is hung up. */
async function end(address: string): Promise<void> {
  if (stateOn("host", address) === "live") hcOn("host", ["kill", address]);
  await expect.poll(() => stateOn("host", address), { timeout: 15_000 }).not.toBe("live");
}

test.beforeAll(() => {
  dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "machine-count-"));
  for (const folder of ["split2122", "single2122", "phone2122"]) mkdirSync(join(dir, folder));
});
test.afterEach(async () => {
  await Promise.all(
    started.splice(0).map(async (address) => {
      await end(address);
      if (stateOn("host", address) === "finished") hcOn("host", ["rm", address]);
    }),
  );
});
test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a machine's count is the sum of the counts of the spaces under it: a split tab counts once, a sub-agent not at all (#2122)", async ({
  page,
}) => {
  const split = join(dir, "split2122");
  const single = join(dir, "single2122");
  const left = start("count-left", split);
  const right = start("count-right", split);
  const alone = start("count-alone", single);
  // A sub-agent is a live terminal of this machine that no tab shows: the machine's row counted it, and no space row did.
  start("count-sub", split, left);
  seedSpaces([
    { id: "spc-split", name: "", folder: split, tabs: [{ id: "tb-split", name: "", terminal: left, beside: [right] }] },
    { id: "spc-single", name: "", folder: single, tabs: [{ id: "tb-single", name: "", terminal: alone }] },
  ]);
  await page.goto("/");
  const spaces = page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Spaces" });
  const thisMachine = spaces.locator("[data-drag-id]").filter({ has: page.locator('[data-machine-header="studio"]') });
  // Four live terminals, three of them in the two tabs: each space row counts its one tab, and the header their sum.
  await expect(thisMachine.locator("[data-row-meta]").getByLabel(/^\d+ tabs$/)).toHaveText(["1", "1"], {
    timeout: 20_000,
  });
  await expect(thisMachine.locator("[data-machine-header]").getByLabel(/^\d+ tabs$/)).toHaveText("2");
});

test.describe("on a phone", () => {
  test.use({ ...phone });

  test("a space's count is the number of tabs the phone lists for it, and its machine's count follows (#2122)", async ({
    page,
  }) => {
    const folder = join(dir, "phone2122");
    const running = start("count-running", folder);
    const over = start("count-over", folder);
    seedSpaces([
      {
        id: "spc-phone",
        name: "",
        folder,
        tabs: [
          { id: "tb-running", name: "", terminal: running },
          { id: "tb-over", name: "", terminal: over },
        ],
      },
    ]);
    // Its program ends before the page opens, so no view saw it end: the document still holds its tab, and a phone
    // lists only the tabs that show a live terminal.
    await end(over);
    // The machines and their spaces are the phone's Spaces tab (#1484).
    await page.goto("/?v=spaces");
    const spaces = page.getByRole("region", { name: "Spaces" });
    const space = rows(spaces).filter({ hasText: "phone2122" });
    await expect(space.getByLabel(/^\d+ tabs$/)).toHaveText("1", { timeout: 20_000 });
    await expect(spaces.locator('[data-machine-header="studio"]').getByLabel(/^\d+ tabs$/)).toHaveText("1");
    // The space's own screen lists that one tab, as its count said.
    await space.click();
    const listed = page.getByRole("region", { name: "Tabs" }).getByRole("button");
    await expect(listed).toHaveCount(1, { timeout: 10_000 });
    await expect(listed).toContainText("count-running");
  });
});
