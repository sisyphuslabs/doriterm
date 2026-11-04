import { expect, test } from "bun:test";
import { installOffer, type InstallFacts, type InstallPrompt } from "./install.ts";

const prompt: InstallPrompt = { prompt: async () => undefined };
const browser: InstallFacts = { installed: false, desktop: false, ios: false, prompt: null };

test.each([
  ["a browser that offers its prompt", { prompt }, "prompt"],
  ["an iPhone or iPad", { ios: true }, "ios"],
  ["a browser with no prompt", {}, null],
  ["the installed app", { installed: true, prompt }, null],
  ["the installed home-screen app on iOS", { installed: true, ios: true }, null],
  ["the desktop shell", { desktop: true, prompt }, null],
] as const)("%s", (_, facts, kind) => {
  expect(installOffer({ ...browser, ...facts })?.kind ?? null).toBe(kind);
});
