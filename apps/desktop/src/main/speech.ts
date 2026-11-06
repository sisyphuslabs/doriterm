import { createRequire } from "node:module";
import { join } from "node:path";
import type { SpeechAddon } from "./dictation.ts";

const require = createRequire(import.meta.url);

/** Where the addon is: beside the app's other resources when packaged (outside asar), in dist/native in a checkout. */
export function speechAddonPath(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? join(resourcesPath, "native", "speech.node") : join(appPath, "dist", "native", "speech.node");
}

const METHODS = ["ready", "speechStatus", "requestSpeech", "supportsOnDevice", "start", "stop", "abort"] as const;

function isSpeechAddon(value: unknown): value is SpeechAddon {
  return (
    typeof value === "object" &&
    value !== null &&
    METHODS.every((name) => typeof Reflect.get(value, name) === "function")
  );
}

/**
 * The macOS recognizer, or undefined when it cannot be used: not built, not loadable, or an app whose Info.plist lacks
 * the usage strings (a checkout's Electron.app), where a permission request would end the app. Dictation is then off,
 * and the page crosses out the mic with why (#726).
 */
export function loadSpeech(path: string, load: (path: string) => unknown = require): SpeechAddon | undefined {
  try {
    const addon = load(path);
    if (!isSpeechAddon(addon)) throw new Error("the addon has the wrong exports");
    if (!addon.ready()) throw new Error("the app's Info.plist lacks the microphone or speech usage string");
    return addon;
  } catch (error) {
    console.log(`dictation off: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
