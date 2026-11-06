import { expect, test } from "bun:test";
import { voiceBlocked } from "./voice-support.ts";

const recognizer = () => class extends EventTarget {};

test("a secure page with a recognizer offers dictation", () => {
  expect(voiceBlocked({ isSecureContext: true, SpeechRecognition: recognizer() })).toBeNull();
  expect(voiceBlocked({ isSecureContext: true, webkitSpeechRecognition: recognizer() })).toBeNull();
});

test("no recognizer, or a page that is not secure, says which", () => {
  expect(voiceBlocked({ isSecureContext: true })).toBe("unsupported");
  expect(voiceBlocked({ isSecureContext: false, SpeechRecognition: recognizer() })).toBe("insecure");
});

const shell = (platform: string, dictation: boolean) => ({
  version: "0.1.2",
  platform,
  ...(dictation ? { dictationStart: () => ({ session: 1 }) } : {}),
});

test("the desktop app dictates only through its own system recognizer, never its Chromium's (#726)", () => {
  const page = { isSecureContext: true, SpeechRecognition: recognizer() };
  expect(voiceBlocked({ ...page, doriface: shell("darwin", true) })).toBeNull();
  expect(voiceBlocked({ ...page, doriface: shell("darwin", false) })).toBe("desktop");
  expect(voiceBlocked({ ...page, doriface: shell("linux", false) })).toBe("desktop");
  expect(voiceBlocked({ ...page, doriface: shell("win32", false) })).toBe("desktop-windows");
  expect(voiceBlocked({ isSecureContext: true, doriface: shell("darwin", false) })).toBe("desktop");
});

test("something on the page that is not the app's bridge is not the desktop app", () => {
  expect(voiceBlocked({ isSecureContext: true, SpeechRecognition: recognizer(), doriface: {} })).toBeNull();
  expect(voiceBlocked({ isSecureContext: true, SpeechRecognition: recognizer(), doriface: "desktop" })).toBeNull();
});
