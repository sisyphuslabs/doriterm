import { useEffect, useState, useSyncExternalStore } from "react";
import { voiceBlocked } from "../settings/voice-support.ts";
import { desktopDictation, desktopRecognizer } from "./desktop-recognizer.ts";
import { Dictation, type DictationOptions, type DictationState } from "./dictation.ts";
import { meshVault } from "../vault/use-mesh-vault.ts";
import { findRecognizer, type RecognizerClass, type Support, type Unavailable } from "./recognizer.ts";
import { type SonioxRecorder, sonioxRecognizer } from "./soniox-recognizer.ts";
import { recognitionLanguage } from "./voice-settings.ts";
import { voiceStore } from "./voice-store.ts";

export interface Voice {
  readonly dictation: Dictation;
  readonly state: DictationState;
  /** Why the mic cannot listen in this browser at all, or null when it can. */
  readonly unavailable: Unavailable | null;
  /** The mic, the palette row and a bound key: start a dictation, or end the one under way. */
  readonly toggle: () => void;
}

const language = () => recognitionLanguage(voiceStore.value, navigator.language);

/**
 * The shell's recognizer, made once per page: it subscribes to the shell's events once, however many surfaces mount and
 * unmount a dictation, so no listener piles up.
 */
let shellRecognizer: RecognizerClass | null | undefined;
function desktopShellRecognizer(): RecognizerClass | null {
  if (shellRecognizer === undefined) {
    const shell = desktopDictation();
    shellRecognizer = shell === null ? null : desktopRecognizer(shell);
  }
  return shellRecognizer;
}

/** A recorder over the microphone; stopping it also releases the microphone. */
async function microphoneRecorder(): Promise<SonioxRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  recorder.addEventListener("stop", () => {
    for (const track of stream.getTracks()) track.stop();
  });
  return recorder;
}

const soniox = sonioxRecognizer({
  key: () => meshVault.sonioxKey(),
  socket: (url, protocols) => new WebSocket(url, [...protocols]),
  recorder: microphoneRecorder,
});

/**
 * How dictation runs on this page. The macOS desktop app uses the system recognizer on this Mac only, so there is no
 * service to ask about and the stored choice is neither read nor written there (#726).
 */
function dictationOptions(): DictationOptions {
  const blocked = voiceBlocked(window);
  // Soniox was chosen in Settings, which is the consent: it needs only a secure page, a microphone and the vault's key.
  if (voiceStore.value.engine === "soniox" && window.isSecureContext) {
    return {
      support: { kind: "ok", recognizer: soniox },
      language,
      engine: () => "service",
      remember: () => undefined,
    };
  }
  const recognizer = blocked === null ? desktopShellRecognizer() : null;
  if (recognizer !== null) {
    return {
      support: { kind: "ok", recognizer },
      language,
      engine: () => "device",
      remember: () => undefined,
      unavailableReason: desktopDictation()?.unavailableReason ?? "device-mac",
    };
  }
  const support: Support = blocked === null ? findRecognizer(window) : { kind: "unavailable", why: blocked };
  return {
    support,
    language,
    engine: () => voiceStore.value.engine,
    remember: (engine) => voiceStore.update({ engine }),
  };
}

/** One dictation for one surface (the phone terminal, the desktop's focused pane); it ends when the surface goes. */
export function useDictation(): Voice {
  const [voice] = useState(() => {
    const options = dictationOptions();
    const dictation = new Dictation(options);
    const { support } = options;
    return { dictation, unavailable: support.kind === "unavailable" ? support.why : null };
  });
  const state = useSyncExternalStore(voice.dictation.subscribe, () => voice.dictation.state);
  useEffect(() => () => voice.dictation.close(), [voice]);
  const toggle = () => (voice.dictation.state.kind === "idle" ? void voice.dictation.start() : voice.dictation.close());
  return { ...voice, state, toggle };
}
