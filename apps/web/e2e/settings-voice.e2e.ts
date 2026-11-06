// Settings > Voice input says what dictation does and where its mic is, says where the audio goes for each way of
// recognizing speech, and where it cannot listen at all it says so instead of showing options that do nothing (#391).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { removeSpeech } from "./speech-stub.ts";

/** The desktop shell's `window.doriface`, as the web app finds it in the Electron window. */
const DESKTOP_BRIDGE = JSON.stringify({ version: "0.1.0", platform: "darwin" });

const openVoiceSection = async (page: Page): Promise<void> => {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Voice input" })
    .or(page.getByRole("button", { name: "Voice input" }))
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Voice input", level: 2 })).toBeVisible();
};

const intro = (page: Page) => page.locator("[data-voice-intro]");

test("the page opens with what dictation does and where the mic that starts it is, above the options", async ({
  page,
}) => {
  await openVoiceSection(page);
  const note = intro(page);
  await expect(note).toBeVisible();
  await expect(note).toContainText("types what you say into the focused terminal");
  await expect(note).toContainText("without pressing Return");
  await expect(note).toContainText("the mic above the terminal");
  // The explanation comes before the options it explains.
  const noteBox = await note.boundingBox();
  const languageBox = await page.getByText("Language", { exact: true }).first().boundingBox();
  expect(noteBox?.y ?? -1).toBeLessThan(languageBox?.y ?? 0);
});

test("each way of recognizing speech says where the audio goes", async ({ page }) => {
  await openVoiceSection(page);
  await expect(page.getByText(/asks before any audio goes to the browser's speech service/)).toBeVisible();
  await page.getByRole("button", { name: "On device", exact: true }).click();
  await expect(page.getByText(/the audio never leaves this device/)).toBeVisible();
  await page.getByRole("button", { name: "Service", exact: true }).click();
  await expect(
    page.getByText(/sends the audio to its speech service, which may run outside this device/),
  ).toBeVisible();
});

test("where the browser has no speech recognition, the page says so instead of two dead options", async ({ page }) => {
  await removeSpeech(page);
  await openVoiceSection(page);
  await expect(intro(page)).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: "Dictation isn't available here" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("This browser has no speech recognition");
  await expect(page.getByText("Speech recognition", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Language/ })).toHaveCount(0);
});

test("in the desktop app, the page says the app cannot dictate and points at the web app", async ({ page }) => {
  await page.addInitScript((bridge) => {
    Reflect.set(window, "doriface", JSON.parse(bridge));
  }, DESKTOP_BRIDGE);
  await openVoiceSection(page);
  // The app's Chromium has a recognizer that its speech service refuses, so no option here could work.
  await expect(intro(page)).toBeVisible();
  const notice = page.getByRole("status").filter({ hasText: "Dictation isn't available here" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("The desktop app can't dictate yet");
  await expect(notice).toContainText("use Doriterm in Chrome or Safari");
  await expect(page.getByText("Speech recognition", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Language/ })).toHaveCount(0);
});
