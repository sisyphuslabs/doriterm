// #2656: Paste invite works in the desktop app although the page holds no clipboard read permission: the shell reads
// the clipboard itself on the click and hands over only an invite link.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildPairingUrl, hostIdOf } from "@doriface/crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";

const signPub = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const INVITE = buildPairingUrl({
  webOrigin: "https://app.doriterm.com",
  hostId: hostIdOf(signPub),
  noiseStaticPub: new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256),
  signPub,
  linkSecret: new Uint8Array(32).fill(7),
  relayUrl: "wss://relay.invalid",
});
const PRIVATE = "hunter2 is my password";

interface Scratch {
  readonly hc: ReturnType<typeof scratchHcSession>;
  readonly profile: string;
}
let scratch: Scratch | undefined;
let launched: ElectronApplication | undefined;

test.beforeAll(async () => {
  const hc = scratchHcSession();
  const profile = mkdtempSync(join(tmpdir(), "dd-paste-invite-"));
  scratch = { hc, profile };
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...hc.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  launched = await electron.launch({ ...launchOptions([`--user-data-dir=${profile}`]), env });
});

test.afterAll(async () => {
  try {
    await launched?.close();
  } finally {
    if (scratch !== undefined) {
      await scratch.hc.dispose();
      rmSync(scratch.profile, { recursive: true, force: true });
    }
  }
});

const running = (): ElectronApplication => {
  if (launched === undefined) throw new Error("the app did not launch");
  return launched;
};

const setClipboard = (text: string): Promise<void> =>
  running().evaluate(async ({ clipboard }, value) => clipboard.writeText(value), text);
const clipboardText = (): Promise<string> => running().evaluate(async ({ clipboard }) => clipboard.readText());

/** The Join a mesh page, opened by navigation alone, so no click or key has reached it yet. */
async function joinPage(): Promise<Page> {
  const page = await running().firstWindow();
  await page.waitForSelector("#root > *");
  const url = new URL(page.url());
  await page.goto(`${url.protocol}//${url.host}/join`);
  await expect(page.getByRole("heading", { name: "Join a mesh", exact: true })).toBeVisible();
  return page;
}

test("a page script with no click before it is refused, and the clipboard is not read", async () => {
  const page = await joinPage();
  await setClipboard(INVITE);
  const answer = await page.evaluate(() => window.doriface?.pasteInvite());
  expect(answer).toEqual({ refused: "gesture" });
  expect(await clipboardText()).toBe(INVITE);
});

test("Paste invite with other text on the clipboard says so and hands none of it to the page", async () => {
  const page = await joinPage();
  await setClipboard(PRIVATE);
  await page.getByRole("button", { name: "Paste invite", exact: true }).click();
  await expect(page.getByText("The clipboard holds no Doriterm invite link.", { exact: false })).toBeVisible();
  expect(await page.content()).not.toContain("hunter2");
  expect(await clipboardText()).toBe(PRIVATE);
});

test("Paste invite with an invite link on the clipboard opens its pairing step and clears the clipboard", async () => {
  const page = await joinPage();
  await setClipboard(INVITE);
  await page.getByRole("button", { name: "Paste invite", exact: true }).click();
  await expect(page.getByRole("button", { name: "They match" })).toBeVisible();
  expect(await clipboardText()).toBe("");
});
