import type { VoiceError } from "@doriface/ui";

/** On-device availability, as SpeechRecognition.available() reports it. */
export type LocalAvailability = "available" | "downloadable" | "downloading" | "unavailable";

export interface RecognizerOptions {
  readonly langs: readonly string[];
  readonly processLocally: boolean;
}

/** One recognition session: the parts of the Web Speech API's SpeechRecognition that dictation uses. */
export interface Recognizer extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  /** Recognize on the device only; absent where the browser predates on-device recognition. */
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
}

/** The SpeechRecognition constructor, with the on-device statics where the browser has them. */
export type RecognizerClass = (new () => Recognizer) & {
  readonly available?: (options: RecognizerOptions) => Promise<LocalAvailability>;
  readonly install?: (options: RecognizerOptions) => Promise<boolean>;
};

/**
 * Why the mic cannot listen at all here: no recognizer, an http page, or a desktop app with no recognizer of its own
 * (`desktop`: Linux or a Mac build without it; `desktop-windows`: not built for Windows yet, #726).
 */
export type Unavailable = "unsupported" | "insecure" | "desktop" | "desktop-windows";

export type Support =
  | { readonly kind: "ok"; readonly recognizer: RecognizerClass }
  | { readonly kind: "unavailable"; readonly why: Unavailable };

interface SpeechScope {
  readonly isSecureContext?: boolean;
  readonly SpeechRecognition?: unknown;
  readonly webkitSpeechRecognition?: unknown;
}

function isRecognizerClass(value: unknown): value is RecognizerClass {
  return typeof value === "function";
}

/** The page's recognizer: the standard constructor, else Chrome's and Safari's prefixed one; none on an http page. */
export function findRecognizer(scope: SpeechScope): Support {
  const recognizer = [scope.SpeechRecognition, scope.webkitSpeechRecognition].find(isRecognizerClass);
  if (recognizer === undefined) return { kind: "unavailable", why: "unsupported" };
  if (scope.isSecureContext !== true) return { kind: "unavailable", why: "insecure" };
  return { kind: "ok", recognizer };
}

/** A SpeechRecognitionErrorEvent code as the strip's reason; null for an abort, which only ever follows Cancel. */
export function errorFor(code: string, local: boolean): VoiceError | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
      return "permission";
    case "no-speech":
      return "no-speech";
    case "audio-capture":
      return "microphone";
    case "network":
      return "network";
    case "language-not-supported":
      return local ? "device" : "language";
    case "service-not-allowed":
      return local ? "device" : "service";
    // The macOS desktop recognizer's own reasons (#726), kept as they are.
    case "mic-system":
    case "speech-system":
    case "device-mac":
    case "mic-windows":
    case "device-windows":
      return code;
    case "busy":
      return "service";
    default:
      return "service";
  }
}
