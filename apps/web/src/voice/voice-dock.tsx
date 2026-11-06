import { VoiceStrip, type VoiceState } from "@doriface/ui";
import type { CSSProperties } from "react";
import { useNow } from "../workspace/use-now.ts";
import type { DictationState } from "./dictation.ts";
import type { Unavailable } from "./recognizer.ts";
import type { Voice } from "./use-dictation.ts";
import { languageName, recognitionLanguage } from "./voice-settings.ts";
import { useVoiceSettings } from "./voice-store.ts";

const WHY: Readonly<Record<Unavailable, string>> = {
  unsupported: "This browser has no speech recognition, so dictation is off here. Chrome, Edge and Safari have it.",
  insecure: "Dictation needs a secure (https) page, and this one was opened over plain http.",
  desktop:
    "The desktop app can't dictate here yet. For dictation, use Doriterm in Chrome or Safari; here, type instead.",
  "desktop-windows":
    "The Windows app can't dictate yet. For dictation, use Doriterm in Chrome or Edge; here, type instead.",
};

function shown(state: Exclude<DictationState, { kind: "idle" }>, now: number): VoiceState {
  const seconds = (since: number) => Math.max(0, Math.floor((now - since) / 1000));
  switch (state.kind) {
    case "unavailable":
      return { kind: "unavailable", why: WHY[state.why] };
    case "listening":
      return { kind: "listening", seconds: seconds(state.since), heard: state.heard, text: state.text };
    case "transcribing":
      return { kind: "transcribing", seconds: seconds(state.since) };
    default:
      return state;
  }
}

export interface VoiceDockProps {
  readonly voice: Voice;
  /** The terminal's title, e.g. "Claude Code". */
  readonly target: string;
  /** Types the transcript at the terminal's cursor: plain input on its stream, never followed by Return. */
  readonly onType: (text: string) => void;
  /** After Cancel, Close, Discard or Not now, with nothing typed. */
  readonly onClose: () => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** The voice strip for a dictation that is under way; nothing while it is idle. */
export function VoiceDock({ voice, target, onType, onClose, className, style }: VoiceDockProps) {
  const settings = useVoiceSettings();
  const now = useNow(1_000);
  const { dictation, state } = voice;
  if (state.kind === "idle") return null;
  return (
    <VoiceStrip
      state={shown(state, now)}
      target={target}
      language={languageName(recognitionLanguage(settings, navigator.language))}
      focusTranscript
      onCancel={() => {
        dictation.close();
        onClose();
      }}
      onStop={() => dictation.stop()}
      onRetry={() => void dictation.start()}
      onAllow={() => void dictation.allowService()}
      onDevice={() => void dictation.keepOnDevice()}
      onEdit={(transcript) => dictation.edit(transcript)}
      onType={() => {
        const text = dictation.take();
        if (text !== null) onType(text);
      }}
      {...(className === undefined ? {} : { className })}
      {...(style === undefined ? {} : { style })}
    />
  );
}
