import { devices, type Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { chordOf, commandModifier } from "./platform-keys.ts";
import { hcOn } from "./machine-switch.ts";
import { type SpeechStub, stubSpeech } from "./speech-stub.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const NAME = "dictate-keys";
const pane = (page: Page) => page.locator('[data-focused="true"]');
const strip = (page: Page) => page.locator("[data-voice-strip]");
const mic = (page: Page) => page.getByRole("button", { name: `Dictate into ${NAME}` });
const transcript = (page: Page) => page.getByRole("textbox", { name: `Transcript for ${NAME}` });

let address = "";
test.beforeEach(() => {
  address = startShell("host", NAME);
});
test.afterEach(() => {
  endAgent("host", address);
});

async function openShell(page: Page): Promise<void> {
  await agentRow(page, NAME, false).click();
  await expect(pane(page).locator(`[data-terminal="${address}"]`)).toContainText("$", { timeout: 15_000 });
}

/**
 * Mic (and Allow, on the page's first dictation), then the recognizer hears `text` as a final result and ends: the
 * transcript is ready to edit.
 */
async function readyWith(page: Page, speech: SpeechStub, text: string, first: boolean): Promise<void> {
  await mic(page).click();
  if (first) await pane(page).getByRole("button", { name: "Allow" }).click();
  await speech.say([text, true]);
  await speech.end();
  await expect(transcript(page)).toHaveValue(text);
  await expect(transcript(page)).toBeFocused();
}

test("the command palette lists Dictate and runs it on the session in view (#194 Q3)", async ({ page }) => {
  await stubSpeech(page);
  await page.goto("/");
  await openShell(page);
  await page.getByRole("button", { name: "Command palette" }).first().click();
  await page.getByRole("combobox", { name: "Command" }).fill("Dictate");
  await page.getByRole("option", { name: /^Dictate/ }).click();
  await expect(pane(page).getByText("Use your browser's speech service?")).toBeVisible();
  await expect(mic(page)).toHaveAttribute("aria-pressed", "true");
});

test("a chord bound to Dictate in Settings > Keybindings starts it from the terminal; there is none by default", async ({
  page,
}) => {
  await stubSpeech(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Keybindings" }).first().click();
  const row = page.locator('[id="keybinding-voice.dictate"]').locator("xpath=../..");
  await expect(row.getByRole("button", { name: /^Remove .* from Dictate$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Record a shortcut for Dictate", exact: true }).click();
  await page.keyboard.press("Control+Alt+Shift+D");
  await expect(row.getByText("Changed")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();

  await openShell(page);
  await pane(page).locator(`[data-terminal="${address}"]`).getByRole("textbox").focus();
  await page.keyboard.press("Control+Alt+Shift+D");
  await expect(pane(page).getByText("Use your browser's speech service?")).toBeVisible();
});

test("Escape in the strip cancels: listening stops and nothing is typed, and a ready transcript is discarded", async ({
  page,
}) => {
  const speech = await stubSpeech(page);
  await page.goto("/");
  await openShell(page);
  await mic(page).click();
  await pane(page).getByRole("button", { name: "Allow" }).click();
  await expect(strip(page)).toHaveAttribute("data-voice-strip", "listening");
  await pane(page).getByRole("button", { name: "Done", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(strip(page)).toHaveCount(0);
  expect(await speech.aborts()).toBe(1);
  await expect(mic(page)).toBeFocused();

  await readyWith(page, speech, "echo escaped-$((3*3))", false);
  await page.keyboard.press("Escape");
  await expect(strip(page)).toHaveCount(0);
  expect(hcOn("host", ["read", address])).not.toContain("escaped");
});

test("Cmd/Ctrl+Enter in the transcript types it at the cursor, with no Return", async ({ page }) => {
  const speech = await stubSpeech(page);
  const typed = "echo keys-$((5*5))";
  await page.goto("/");
  await openShell(page);
  await readyWith(page, speech, typed, true);
  await page.keyboard.press(chordOf(`${await commandModifier(page)}+enter`));
  await expect(strip(page)).toHaveCount(0);
  await expect.poll(() => hcOn("host", ["read", address])).toContain(`$ ${typed}`);
  expect(hcOn("host", ["read", address])).not.toContain("keys-25");
  await expect(pane(page).locator(`[data-terminal="${address}"]`).getByRole("textbox")).toBeFocused();
});

test.describe("on a phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("a chord bound to Dictate reaches the open terminal's dictation from the phone shell", async ({ page }) => {
    await stubSpeech(page);
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Keybindings" }).click();
    await page.getByRole("button", { name: "Record a shortcut for Dictate", exact: true }).click();
    await page.keyboard.press("Control+Alt+Shift+D");
    await expect(
      page.locator('[id="keybinding-voice.dictate"]').locator("xpath=../..").getByText("Changed"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();

    await agentRow(page, NAME, false).click();
    const terminal = page.locator(`[data-terminal="${address}"]`);
    await expect(terminal).toContainText("$", { timeout: 15_000 });
    await terminal.getByRole("textbox").focus();
    await page.keyboard.press("Control+Alt+Shift+D");
    await expect(page.getByText("Use your browser's speech service?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Show keyboard" })).toHaveCount(0);
  });
});
