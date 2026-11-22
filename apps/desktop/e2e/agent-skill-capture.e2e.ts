// Settings > Machines in the desktop app before and after Install of the agent skill, on this computer and on an added
// machine with a host of its own, at 1440 and 390 (#2653). Both hosts run with a scratch HOME:
// CAPTURE=1 CAPTURE_DIR=<dir> bunx playwright test agent-skill-capture
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn } from "node:child_process";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");

let session: ReturnType<typeof scratchHcSession> | undefined;
let root: string | undefined;
let launched: ElectronApplication | undefined;
let machine: ChildProcess | undefined;
const MACHINE_NAME = "build-box";

test.beforeAll(async () => {
  session = scratchHcSession();
  root = mkdtempSync(join(tmpdir(), "dd-skill-"));
  const home = join(root, "home");
  mkdirSync(home);
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...session.env, HOME: home }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const added = spawn(
    "bun",
    [join(import.meta.dirname, "..", "..", "web", "e2e", "added-machine.ts"), join(root, "machine")],
    {
      env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  machine = added;
  await new Promise<void>((resolve, reject) => {
    added.stdout?.on("data", (chunk: Buffer) => (chunk.toString().includes("READY") ? resolve() : undefined));
    added.once("exit", (code) => reject(new Error(`the added machine's setup exited (${code})`)));
  });
  launched = await electron.launch(await launchOptions([`--user-data-dir=${join(root, "profile")}`], { env }));
});

test.afterAll(async () => {
  try {
    await launched?.close();
    if (machine !== undefined && machine.exitCode === null) {
      const exited = new Promise((resolve) => machine?.once("exit", resolve));
      machine.kill("SIGTERM");
      await exited;
    }
  } finally {
    await session?.dispose();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env["CAPTURE_DIR"] ?? test.info().outputDir;
  for (const size of WIDTHS) {
    // oxlint-disable-next-line no-await-in-loop -- one width after another on the same window
    await page.setViewportSize(size);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.mouse.move(1, 1);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.evaluate(() => document.fonts.ready);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await page.screenshot({ path: join(dir, `desktop-agent-skill-${name}-${size.width}-day.png`) });
  }
  await page.setViewportSize(WIDTHS[0]);
}

test("Settings > Machines installs the agent skill on this computer and on the added machine", async () => {
  test.setTimeout(120_000);
  if (launched === undefined) throw new Error("the app did not launch");
  const page = await launched.firstWindow();
  const started = page.getByRole("button", { name: "Use this computer" });
  const workspace = page
    .getByRole("button", { name: "New tab" })
    .or(page.getByRole("button", { name: "New terminal" }))
    .first();
  await expect(started.or(workspace)).toBeVisible({ timeout: 60_000 });
  if (await started.isVisible()) await started.click();
  await expect(workspace).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() =>
    localStorage.setItem(
      "doriface.appearance",
      JSON.stringify({ mode: "light", dark: "night", light: "day", density: "comfortable", custom: [] }),
    ),
  );
  const url = new URL(page.url());
  await page.goto(`${url.protocol}//${url.host}/settings#machines`);
  const rows = page.getByRole("list", { name: "Machines" }).getByRole("listitem");
  const added = rows.filter({ hasText: MACHINE_NAME });
  const here = rows.first();
  await expect(here).toContainText("Agent skill not installed", { timeout: 30_000 });
  await expect(added).toContainText("Agent skill not installed", { timeout: 30_000 });
  await shoot(page, "before");
  await here.getByRole("button", { name: /^Install agent skill on / }).click();
  await expect(here).toContainText(/Agent skill installed v\S+/, { timeout: 30_000 });
  await added.getByRole("button", { name: `Install agent skill on ${MACHINE_NAME}` }).click();
  await expect(added).toContainText(/Agent skill installed v\S+/, { timeout: 30_000 });
  await shoot(page, "after");
});
