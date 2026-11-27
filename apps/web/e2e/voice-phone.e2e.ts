import { devices, type Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";
import { stubSpeech } from "./speech-stub.ts";
import { openSettingsSection } from "./settings-sections.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

const NAME = "dictate";
const header = (page: Page) => page.getByRole("banner");
const mic = (page: Page) => header(page).getByRole("button", { name: `Dictate into ${NAME}` });
// With the soft keyboard down (always, in headless Chromium) the keys bar is its round Show keyboard button (#195).
const keyBar = (page: Page) => page.getByRole("button", { name: "Show keyboard" });
const transcript = (page: Page) => page.getByRole("textbox", { name: `Transcript for ${NAME}` });
const announced = (page: Page, words: string) => page.getByRole("status").filter({ hasText: words });

let address = "";
test.beforeEach(() => {
  address = startShell("host", NAME);
});
test.afterEach(() => {
  endAgent("host", address);
});

async function openShell(page: Page): Promise<void> {
  await page.goto("/");
  await agentRow(page, NAME, false).click();
  await expect(page.locator(`[data-terminal="${address}"]`)).toContainText("$", { timeout: 15_000 });
}

/** The mic, then Allow on the first-use question about the browser's speech service. */
async function startListening(page: Page): Promise<void> {
  await mic(page).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(announced(page, "Listening")).toBeVisible();
}

test("dictation asks first, listens, transcribes, and types the edited transcript at the cursor without Enter", async ({
  page,
}) => {
  const speech = await stubSpeech(page);
  const link = await routeHcSocket(page);
  await openShell(page);

  await mic(page).click();
  await expect(page.getByText("Use your browser's speech service?")).toBeVisible();
  expect(await speech.started()).toEqual([]);
  await page.getByRole("button", { name: "Allow" }).click();

  // Listening: the strip takes the key bar's place and the language is the browser's own.
  await expect(announced(page, "Listening")).toBeVisible();
  await expect(page.getByText("Listening · English (United States)")).toBeVisible();
  await expect(keyBar(page)).toHaveCount(0);
  await expect(mic(page)).toHaveAttribute("aria-pressed", "true");
  expect(await speech.started()).toEqual([
    { lang: "en-US", continuous: false, interimResults: true, processLocally: false },
  ]);
  await speech.say(["echo voice", false]);
  await expect(page.getByText("echo voice", { exact: true })).toBeVisible();

  // Transcribing: Done stops the recognizer, which still owes its last words.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(announced(page, "Transcribing")).toBeVisible();
  expect(await speech.stops()).toBe(1);

  // Transcript ready: editable, and nothing has reached the terminal yet.
  await speech.say(["echo voice-$((40+1))", true]);
  await speech.end();
  await expect(transcript(page)).toHaveValue("echo voice-$((40+1))");
  await expect(transcript(page)).toBeFocused();
  expect(link.sent().some((frame) => frame.includes("echo voice"))).toBe(false);
  await transcript(page).fill("echo voice-$((40+2))\n");
  await page.getByRole("button", { name: `Type into ${NAME}` }).click();
  await expect(keyBar(page).first()).toBeVisible();

  // Typed as plain input on the terminal stream: one DATA frame ending in the text, no Return, nothing run.
  const typed = "echo voice-$((40+2))";
  await expect.poll(() => hcOn("host", ["read", address])).toContain(`$ ${typed}`);
  const frames = link.sent().filter((frame) => frame.includes(typed));
  expect(frames).toHaveLength(1);
  expect(frames[0]?.endsWith(typed)).toBe(true);
  expect(hcOn("host", ["read", address])).not.toContain("voice-42");

  // The text sits at the shell's cursor: Return in the terminal runs it.
  await page.locator(`[data-terminal="${address}"]`).getByRole("textbox").press("Enter");
  await expect.poll(() => hcOn("host", ["read", address])).toContain("voice-42");

  // The answer is remembered: the next dictation starts straight away, and Cancel types nothing.
  await mic(page).click();
  await expect(announced(page, "Listening")).toBeVisible();
  await speech.say(["rm -rf build", true]);
  await page.getByRole("button", { name: "Cancel dictation" }).click();
  await expect(keyBar(page).first()).toBeVisible();
  expect(await speech.aborts()).toBe(1);
  expect(link.sent().some((frame) => frame.includes("rm -rf build"))).toBe(false);
});

test("a denied microphone says how to allow it, and Try again listens anew", async ({ page }) => {
  const speech = await stubSpeech(page);
  await openShell(page);
  await startListening(page);
  await speech.fail("not-allowed");
  const alert = page.getByRole("alert").filter({ hasText: "Microphone access is off" });
  await expect(alert).toContainText("site settings");
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(announced(page, "Listening")).toBeVisible();
  expect(await speech.started()).toHaveLength(2);
  await page.getByRole("button", { name: "Cancel dictation" }).click();
  await expect(keyBar(page).first()).toBeVisible();
});

test("a take with no speech says nothing was typed, and Close brings the key bar back", async ({ page }) => {
  const speech = await stubSpeech(page);
  await openShell(page);
  await startListening(page);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await speech.end();
  const notice = page.getByRole("status").filter({ hasText: "Didn't catch anything" });
  await expect(notice).toContainText("Nothing was typed");
  await notice.getByRole("button", { name: "Close" }).click();
  await expect(keyBar(page).first()).toBeVisible();
  await expect(mic(page)).toHaveAttribute("aria-pressed", "false");
});

test("Settings > Voice input picks the language and the speech service, and the next dictation uses both", async ({
  page,
}) => {
  const speech = await stubSpeech(page);
  await page.goto("/settings");
  await openSettingsSection(page, "Voice input");
  await page.getByRole("button", { name: /^Language/ }).click();
  await page.getByRole("menuitem", { name: "Korean (South Korea)" }).click();
  await expect(page.getByRole("button", { name: /^Language/ })).toContainText("Korean (South Korea)");
  await page.getByRole("button", { name: "Service", exact: true }).click();
  await expect(page.getByRole("button", { name: "Service", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close settings" }).click();

  await agentRow(page, NAME, false).click();
  await expect(page.locator(`[data-terminal="${address}"]`)).toContainText("$", { timeout: 15_000 });
  await mic(page).click();
  // Allowed in Settings: no first-use question.
  await expect(page.getByText("Listening · Korean (South Korea)")).toBeVisible();
  expect((await speech.started()).map((session) => session.lang)).toEqual(["ko-KR"]);
  await page.getByRole("button", { name: "Cancel dictation" }).click();
});

test("the listening light pulses, and holds still under reduced motion", async ({ page }) => {
  const speech = await stubSpeech(page);
  await openShell(page);
  await startListening(page);
  await speech.say(["hello", false]);
  const light = page.locator("[data-voice-heard]");
  await expect(light).toHaveAttribute("data-voice-heard", "true");
  expect(await light.evaluate((el) => getComputedStyle(el).animationName)).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await light.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.getByRole("button", { name: "Cancel dictation" }).click();
});

test("listening ends when the recognizer ends the utterance, with no Done, and the transcript waits to be edited", async ({
  page,
}) => {
  const speech = await stubSpeech(page);
  await openShell(page);
  await startListening(page);
  await speech.say(["git status", false]);
  await speech.speechEnd();
  await expect(announced(page, "Transcribing")).toBeVisible();
  expect(await speech.stops()).toBe(0);
  await speech.say(["git status", true]);
  await speech.end();
  await expect(transcript(page)).toHaveValue("git status");
  await expect(transcript(page)).toBeEditable();
  expect(hcOn("host", ["read", address])).not.toContain("git status");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(keyBar(page).first()).toBeVisible();
});
