/** Why a dictation ended without a transcript. */
export type VoiceError = "permission" | "no-speech" | "microphone" | "network" | "language" | "service" | "device";

interface ErrorCopy {
  readonly tone: "warning" | "error";
  readonly title: (language: string) => string;
  readonly body: (language: string) => string;
  /** Whether trying again can help without a change elsewhere first. */
  readonly retry: boolean;
}

/** Every failure says that nothing was typed, or what to change before trying again. */
export const VOICE_ERROR_COPY: Readonly<Record<VoiceError, ErrorCopy>> = {
  permission: {
    tone: "error",
    title: () => "Microphone access is off",
    body: () => "Allow the microphone for Doriterm in the browser's site settings, then try again.",
    retry: true,
  },
  "no-speech": {
    tone: "warning",
    title: () => "Didn't catch anything",
    body: () => "Nothing was typed. Try again a little closer to the microphone.",
    retry: true,
  },
  microphone: {
    tone: "error",
    title: () => "No microphone found",
    body: () => "Connect or turn on a microphone, then try again.",
    retry: true,
  },
  network: {
    tone: "warning",
    title: () => "The speech service didn't answer",
    body: () => "Nothing was typed. Check the connection, then try again.",
    retry: true,
  },
  language: {
    tone: "warning",
    title: (language) => `${language} isn't supported`,
    body: () => "The speech service can't recognize this language. Pick another in Settings > Voice input.",
    retry: false,
  },
  service: {
    tone: "error",
    title: () => "Speech recognition is turned off",
    body: () => "The browser or the system refused speech recognition. Nothing was typed.",
    retry: true,
  },
  device: {
    tone: "warning",
    title: () => "Not available on this device",
    body: (language) =>
      `This browser can't recognize ${language} on the device itself. Allow its speech service in Settings > Voice input, or type instead.`,
    retry: false,
  },
};
