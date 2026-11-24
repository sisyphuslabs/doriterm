/**
 * Where speech becomes text. soniox: Soniox's service, with the key from the mesh vault. ask: on first use, say the browser's speech service may hear the audio and wait for
 * a yes; device: only the browser's on-device recognizer; service: the browser's speech service, already allowed.
 */
export type Engine = "ask" | "device" | "service" | "soniox";

export interface VoiceSettings {
  /** A BCP 47 tag, or "" to follow the browser's language. */
  readonly language: string;
  readonly engine: Engine;
}

export const VOICE_KEY = "doriface.voice";
export const DEFAULT_VOICE: VoiceSettings = { language: "", engine: "ask" };
const ENGINES: readonly Engine[] = ["ask", "device", "service", "soniox"];

/** The languages Settings offers; the browser's own is offered first, and a stored one stays listed. */
export const VOICE_LANGUAGES: readonly string[] = [
  "en-US",
  "en-GB",
  "ko-KR",
  "ja-JP",
  "zh-CN",
  "zh-TW",
  "es-ES",
  "fr-FR",
  "de-DE",
  "pt-BR",
  "it-IT",
  "hi-IN",
];

const isEngine = (value: unknown): value is Engine => ENGINES.some((engine) => engine === value);

export function parseVoiceSettings(raw: string | null): VoiceSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch (cause) {
    if (cause instanceof SyntaxError) return DEFAULT_VOICE;
    throw cause;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_VOICE;
  const language: unknown = Reflect.get(parsed, "language");
  const engine: unknown = Reflect.get(parsed, "engine");
  return {
    language: typeof language === "string" ? language : DEFAULT_VOICE.language,
    engine: isEngine(engine) ? engine : DEFAULT_VOICE.engine,
  };
}

/** The tag recognition runs in: the one picked in Settings, else the browser's, else US English. */
export function recognitionLanguage(settings: VoiceSettings, browser: string | undefined): string {
  if (settings.language !== "") return settings.language;
  return browser === undefined || browser === "" ? "en-US" : browser;
}

/** A language tag in words, e.g. "Korean (South Korea)"; the tag itself when it names no language. */
export function languageName(tag: string): string {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(tag);
  } catch (cause) {
    if (cause instanceof RangeError) return tag;
    throw cause;
  }
  const language = new Intl.DisplayNames(["en"], { type: "language" }).of(locale.language) ?? tag;
  const region =
    locale.region === undefined ? undefined : new Intl.DisplayNames(["en"], { type: "region" }).of(locale.region);
  return region === undefined ? language : `${language} (${region})`;
}
