import { findRecognizer, type Unavailable } from "../voice/recognizer.ts";

/** Why this page cannot offer dictation: no recognizer here, an insecure page, or a desktop app without one. */
export type VoiceBlocked = Unavailable;

interface PageScope {
  readonly isSecureContext?: boolean;
  readonly SpeechRecognition?: unknown;
  readonly webkitSpeechRecognition?: unknown;
  readonly doriface?: unknown;
}

const desktopShell = (scope: PageScope): object | null =>
  typeof scope.doriface === "object" && scope.doriface !== null && "version" in scope.doriface ? scope.doriface : null;

/**
 * Why dictation cannot work on this page, or null where it can. The desktop app's Chromium has a recognizer, but its
 * network speech service refuses it and its on-device path reports unavailable (measured on Electron 45.2.1 /
 * Chromium 156), so the app dictates only through the shell's own system recognizer: on a Mac whose build carries it
 * (#726). Windows has none built yet; Linux has no system recognizer.
 */
export function voiceBlocked(scope: PageScope): VoiceBlocked | null {
  const shell = desktopShell(scope);
  if (shell !== null) {
    if (typeof Reflect.get(shell, "dictationStart") === "function") return null;
    return Reflect.get(shell, "platform") === "win32" ? "desktop-windows" : "desktop";
  }
  const support = findRecognizer(scope);
  return support.kind === "unavailable" ? support.why : null;
}
