import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
  readonly env: Record<string, string>;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;
const agents: string[] = [];

// One app and one hc core: the tests run in order and share them.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const session = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-profile-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...session.env }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  scratch = { hc: session, profile, env };
  launched = await electron.launch(await launchOptions([`--user-data-dir=${profile}`], { env }));
  // The main process's own Notification, stubbed: each show() is recorded instead of reaching the OS.
  await launched.evaluate(({ Notification }) => {
    const shown: unknown[] = [];
    Reflect.set(globalThis, "shownNotices", shown);
    Notification.isSupported = () => true;
    Notification.prototype.show = function show(this: Electron.Notification) {
      shown.push(this);
    };
  });
});

test.afterAll(async () => {
  try {
    for (const address of agents.splice(0)) hc(["kill", address]);
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
    }
  }
});

const app = (): ElectronApplication => {
  if (launched === undefined) throw new Error("the app did not launch");
  return launched;
};

function hc(args: readonly string[]): string {
  if (scratch === undefined) throw new Error("no scratch session");
  return execFileSync(scratch.env["HC_BIN"] ?? "hc", args, { env: scratch.env, encoding: "utf8" });
}

const osc = (fields: string): string => `printf '\\033]7501;${fields}\\033\\\\'`;

/** An agent that works until it gets a line, then reports `state` (done, or blocked for input); returns its address. */
function agent(name: string, then: string): string {
  const script = [osc("state=working:app=claude"), "read go", osc(then), "exec sleep 600"].join("; ");
  const out = hc(["run", "--bg", "--name", name, "--", "sh", "-c", script]);
  const address = String(Reflect.get(JSON.parse(out), "address"));
  agents.push(address);
  return address;
}

const press = (address: string): void => void hc(["keys", address, "enter"]);

/** What the stubbed Notification was asked to show, in order. */
const shown = (): Promise<{ title: string; body: string }[]> =>
  app().evaluate(() =>
    (Reflect.get(globalThis, "shownNotices") as Electron.Notification[]).map(({ title, body }) => ({ title, body })),
  );

const section = (page: Page) => page.locator("[data-push-state]");
const button = (page: Page, name: string) => section(page).getByRole("button", { name, exact: true });

async function openNotifications(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page).toHaveURL(/\/settings$/);
  await page
    .getByRole("navigation", { name: "Settings", exact: true })
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
}

test("Settings > Notifications turns native notifications on, and Send test shows one", async () => {
  const page = await app().firstWindow();
  await page.getByRole("button", { name: "Use this computer" }).click();
  await expect(
    page
      .getByRole("button", { name: "New tab" })
      .or(page.getByRole("button", { name: "New terminal" }))
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await openNotifications(page);
  await expect(section(page)).toHaveAttribute("data-push-state", "off");
  await expect(page.getByText("Not in the desktop app yet")).toHaveCount(0);
  await button(page, "Turn on").click();
  await expect(section(page)).toHaveAttribute("data-push-state", "on");
  await button(page, "Send test").click();
  await expect.poll(shown).toEqual([{ title: "Doriterm", body: "Notifications on this computer work." }]);
});

test("an agent that finishes its turn shows a native notification, and a turned-off event shows none", async () => {
  const page = await app().firstWindow();
  const finished = agent("notify-done", "state=done:app=claude");
  press(finished);
  // What it is about comes from the app's own connection (#1908): the agent and machine, then where and what happened.
  await expect.poll(shown).toEqual([
    { title: "Doriterm", body: "Notifications on this computer work." },
    {
      title: expect.stringMatching(/^claude(@\S+)?$/),
      body: expect.stringMatching(/notify-done — Finished its turn$/),
    },
  ]);

  await section(page).getByRole("switch", { name: "An agent finishes its turn" }).click();
  await expect(section(page).getByRole("switch", { name: "An agent finishes its turn" })).not.toBeChecked();
  const quiet = agent("notify-quiet", "state=done:app=claude");
  press(quiet);
  // Its done is in hc, and so in the app's feed, before the next agent asks for input.
  await expect.poll(() => hc(["get", quiet, "--json"])).toContain('"state":"done"');
  const asking = agent("notify-input", "state=blocked:app=claude");
  press(asking);
  await expect.poll(async () => (await shown()).at(-1)?.body).toMatch(/notify-input — Waiting for your input$/);
  expect(await shown()).toHaveLength(3);
});

test("clicking a notification opens the pane it is about", async () => {
  const page = await app().firstWindow();
  const [address] = agents;
  if (address === undefined) throw new Error("no agent from the earlier test");
  await expect(page).toHaveURL(/\/settings$/);
  // The second notice is the finished agent's.
  await app().evaluate(() => (Reflect.get(globalThis, "shownNotices") as Electron.Notification[])[1]?.emit("click"));
  await expect(page.locator(`[data-focused="true"] [data-terminal="${address}"]`)).toBeVisible({ timeout: 15_000 });
});
