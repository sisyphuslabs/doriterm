import type { Page } from "@playwright/test";
import type { Shot, Width } from "./capture-shots.ts";
import { expect } from "./fixtures.ts";
import { type SpeechStub, stubSpeech } from "./speech-stub.ts";

/** The seeded shell, open, with the stubbed recognizer: on a phone full screen, on desktop as the focused pane. */
async function openShell(page: Page, width: Width): Promise<SpeechStub> {
  const speech = await stubSpeech(page);
  await page.goto("/");
  await page.getByRole("button", { name: /shell/ }).first().click();
  const terminal =
    width === "390" ? page.locator("[data-terminal]") : page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return speech;
}

async function listening(page: Page, width: Width): Promise<SpeechStub> {
  const speech = await openShell(page, width);
  await page.getByRole("button", { name: "Dictate into shell" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await speech.say(["마이그레이션 롤백 스크립트부터 보여줘. Then run the", false]);
  await expect(page.locator('[data-voice-heard="true"]')).toBeVisible();
  return speech;
}

/** #194: the first-use question, listening, and the transcript ready to edit, in the real app. */
export const VOICE_SHOTS: readonly Shot[] = [
  {
    name: "voice-consent",
    start: "connected",
    run: async (page, width) => {
      await openShell(page, width);
      await page.getByRole("button", { name: "Dictate into shell" }).click();
      await expect(page.getByText("Use your browser's speech service?")).toBeVisible();
    },
  },
  { name: "voice-listening", start: "connected", run: async (page, width) => void (await listening(page, width)) },
  {
    name: "voice-ready",
    start: "connected",
    run: async (page, width) => {
      const speech = await listening(page, width);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await speech.say(["마이그레이션 롤백 스크립트부터 보여줘.", true], [" Then run the db tests again.", true]);
      await speech.end();
      await expect(page.getByRole("textbox", { name: "Transcript for shell" })).toBeVisible();
    },
  },
  {
    name: "settings-voice-input",
    start: "connected",
    run: async (page) => {
      await page.goto("/settings");
      await page
        .getByRole("tab", { name: "Voice input" })
        .or(page.getByRole("button", { name: "Voice input" }))
        .first()
        .click();
      await expect(page.getByRole("heading", { name: "Voice input", exact: true })).toBeVisible();
    },
  },
  {
    name: "settings-voice-desktop",
    start: "connected",
    run: async (page) => {
      // The desktop shell's Chromium has a recognizer its speech service refuses, so the app's page says so instead.
      await page.addInitScript(() => {
        Reflect.set(window, "doriface", { version: "0.1.0", platform: "darwin" });
      });
      await page.goto("/settings");
      await page
        .getByRole("tab", { name: "Voice input" })
        .or(page.getByRole("button", { name: "Voice input" }))
        .first()
        .click();
      await expect(page.getByText("The desktop app can't dictate yet")).toBeVisible();
    },
  },
];
