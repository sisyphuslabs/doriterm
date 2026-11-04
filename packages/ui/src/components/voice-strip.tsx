import { Mic, Square, X } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";
import { inputClass } from "./input.tsx";
import { Notice } from "./notice.tsx";
import { Spinner } from "./spinner.tsx";

/**
 * listening: recording, with the input level. transcribing: audio stopped, text not back yet.
 * ready: the transcript, editable, not yet typed into the terminal. error: what went wrong and the next step.
 */
export type VoiceState =
  | { readonly kind: "listening"; readonly seconds: number; readonly levels: readonly number[] }
  | { readonly kind: "transcribing"; readonly seconds: number }
  | { readonly kind: "ready"; readonly transcript: string }
  | { readonly kind: "error"; readonly reason: "permission" | "no-speech" };

export interface VoiceStripProps {
  readonly state: VoiceState;
  /** Where the text goes, e.g. "Claude Code". */
  readonly target: string;
  /** Recognition language as a word, e.g. "Korean". */
  readonly language: string;
  readonly onCancel?: () => void;
  readonly onStop?: () => void;
  readonly onType?: () => void;
  readonly onRetry?: () => void;
  readonly className?: string;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function Level({ levels }: { readonly levels: readonly number[] }) {
  return (
    <span aria-hidden className="flex h-5 min-w-0 flex-1 items-center gap-[3px] overflow-hidden">
      {levels.map((level, index) => (
        <span
          key={index}
          style={{ height: `${Math.max(12, Math.round(level * 100))}%` }}
          className="w-[3px] shrink-0 rounded-full bg-foreground"
        />
      ))}
    </span>
  );
}

const ERROR_COPY = {
  permission: {
    title: "Microphone access is off",
    body: "Allow the microphone for doriface in the browser's site settings, then try again.",
  },
  "no-speech": {
    title: "Didn't catch anything",
    body: "Nothing was typed. Try again a little closer to the microphone.",
  },
} as const;

/** Dictation for a terminal: docked where the key bar sits on phones, and under the focused pane on desktop. */
export function VoiceStrip({ state, target, language, onCancel, onStop, onType, onRetry, className }: VoiceStripProps) {
  const shell = cn(
    "flex shrink-0 flex-col gap-2 border-t border-border bg-chrome px-2 pt-2 pb-[max(0.5rem,var(--safe-bottom))]",
    className,
  );
  if (state.kind === "error") {
    const copy = ERROR_COPY[state.reason];
    return (
      <div className={shell}>
        <Notice
          tone={state.reason === "permission" ? "error" : "warning"}
          title={copy.title}
          actions={
            <>
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Close
              </Button>
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Try again
              </Button>
            </>
          }
          className="coarse:flex-wrap [&>div:last-child]:coarse:w-full [&>div:last-child]:coarse:justify-end"
        >
          {copy.body}
        </Notice>
      </div>
    );
  }
  if (state.kind === "ready") {
    return (
      <div className={shell}>
        <label className="sr-only" htmlFor="voice-transcript">
          Transcript for {target}
        </label>
        <textarea
          id="voice-transcript"
          rows={2}
          defaultValue={state.transcript}
          className={cn(inputClass, "h-auto resize-none py-1.5 leading-normal")}
        />
        <p className="px-1 text-xs text-muted-foreground">Types at the cursor. Return in the terminal sends it.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="coarse:flex-1">
            Discard
          </Button>
          <Button variant="primary" size="sm" onClick={onType} className="coarse:flex-[2]">
            Type into {target}
          </Button>
        </div>
      </div>
    );
  }
  const listening = state.kind === "listening";
  return (
    <div className={shell}>
      <p
        role="status"
        aria-live="polite"
        className="flex items-center justify-between px-1 text-xs text-muted-foreground"
      >
        <span>{listening ? `Listening · ${language}` : `Transcribing for ${target}…`}</span>
        <span className="tabular-nums">{clock(state.seconds)}</span>
      </p>
      <div className="flex items-center gap-2">
        <IconButton label="Cancel dictation" icon={<X />} size="md" onClick={onCancel} />
        <span className="flex h-(--control) min-w-0 flex-1 items-center gap-2.5 rounded-md bg-raised px-2.5">
          {listening ? <Mic aria-hidden className="size-4 shrink-0 text-foreground" /> : <Spinner className="size-4" />}
          {listening ? (
            <Level levels={state.levels} />
          ) : (
            <span className="text-sm text-muted-foreground">Turning speech into text</span>
          )}
        </span>
        <Button variant="primary" size="md" loading={!listening} onClick={onStop}>
          <Square aria-hidden className="fill-current" />
          Done
        </Button>
      </div>
    </div>
  );
}
