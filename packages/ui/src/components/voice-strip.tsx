import { Mic, Square, X } from "lucide-react";
import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { IconButton } from "./icon-button.tsx";
import { fieldLabelClass, inputClass } from "./input.tsx";
import { Notice } from "./notice.tsx";
import { Spinner } from "./spinner.tsx";
import { VOICE_ERROR_COPY, type VoiceError } from "./voice-copy.ts";

/**
 * unavailable: no recognizer here, with why. consent: before the browser's speech service hears anything (device:
 * on-device recognition is offered too). preparing: the on-device language pack installs. listening: recording, with
 * what has been heard so far. transcribing: the speech ended or Done was pressed, the last words still owed. ready: the transcript, editable,
 * not yet typed. error: what went wrong and the next step.
 */
export type VoiceState =
  | { readonly kind: "unavailable"; readonly why: string }
  | { readonly kind: "consent"; readonly device: boolean }
  | { readonly kind: "preparing" }
  | { readonly kind: "listening"; readonly seconds: number; readonly heard: boolean; readonly text: string }
  | { readonly kind: "transcribing"; readonly seconds: number }
  | { readonly kind: "ready"; readonly transcript: string }
  | { readonly kind: "error"; readonly reason: VoiceError };

export interface VoiceStripProps {
  readonly state: VoiceState;
  /** Where the text goes, e.g. "Claude Code". */
  readonly target: string;
  /** Recognition language as words, e.g. "Korean (South Korea)". */
  readonly language: string;
  /** Cancel, Close, Discard, Not now, and Escape anywhere in the strip. */
  readonly onCancel?: () => void;
  readonly onStop?: () => void;
  readonly onType?: () => void;
  readonly onRetry?: () => void;
  readonly onEdit?: (transcript: string) => void;
  readonly onAllow?: () => void;
  readonly onDevice?: () => void;
  /** Moves focus into the transcript once it is ready, so it can be edited straight away. */
  readonly focusTranscript?: boolean;
  readonly className?: string;
  /** Placement from the screen, e.g. a margin that lifts the strip onto the soft keyboard. */
  readonly style?: CSSProperties;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const WRAP_ACTIONS = "coarse:flex-wrap [&>div:last-child]:coarse:w-full [&>div:last-child]:coarse:justify-end";

/** Dictation for a terminal: docked where the key bar sits on phones, and under the focused pane on desktop. */
export function VoiceStrip(props: VoiceStripProps) {
  const { state, target, language, onCancel, onStop, onType, onRetry, onEdit, onAllow, onDevice, className } = props;
  const focusTranscript = props.focusTranscript ?? false;
  const transcriptId = useId();
  const shell = cn(
    "flex shrink-0 flex-col gap-2 border-t border-border bg-chrome px-2 pt-2 pb-[max(0.5rem,var(--safe-bottom))]",
    className,
  );
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel?.();
  };
  const close = (label = "Close") => (
    <Button variant="ghost" size="sm" onClick={onCancel}>
      {label}
    </Button>
  );
  const frame = (body: ReactNode) => (
    <section
      aria-label={`Dictation into ${target}`}
      data-voice-strip={state.kind}
      className={shell}
      style={props.style}
      onKeyDown={onKeyDown}
    >
      {body}
    </section>
  );

  if (state.kind === "unavailable") {
    return frame(
      <Notice tone="info" title="Dictation isn't available here" actions={close()} className={WRAP_ACTIONS}>
        {state.why}
      </Notice>,
    );
  }
  if (state.kind === "consent") {
    return frame(
      <Notice
        tone="info"
        title="Use your browser's speech service?"
        className={WRAP_ACTIONS}
        actions={
          <>
            {close("Not now")}
            {state.device ? (
              <Button variant="secondary" size="sm" onClick={onDevice}>
                On this device only
              </Button>
            ) : null}
            <Button variant="primary" size="sm" onClick={onAllow}>
              Allow
            </Button>
          </>
        }
      >
        To turn speech into text, the browser sends the audio to its speech service, which may run on a server outside
        this device. Doriterm never keeps or sends the audio itself.
        {state.device ? ` On this device only downloads ${language} recognition once and keeps the audio here.` : ""}
      </Notice>,
    );
  }
  if (state.kind === "error") {
    const copy = VOICE_ERROR_COPY[state.reason];
    return frame(
      <Notice
        tone={copy.tone}
        title={copy.title(language)}
        className={WRAP_ACTIONS}
        actions={
          <>
            {close()}
            {copy.retry ? (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </>
        }
      >
        {copy.body(language)}
      </Notice>,
    );
  }
  if (state.kind === "ready") {
    const typed = state.transcript.trim() !== "";
    return frame(
      <>
        <label className={cn("px-1", fieldLabelClass)} htmlFor={transcriptId}>
          Transcript for {target}
        </label>
        <p role="status" className="sr-only">
          Transcript ready. Edit it, then type it into {target}.
        </p>
        <textarea
          id={transcriptId}
          rows={2}
          autoFocus={focusTranscript}
          value={state.transcript}
          onChange={(event) => onEdit?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && typed) onType?.();
          }}
          className={cn(inputClass, "h-auto resize-none py-1.5 leading-normal")}
        />
        <p className="px-1 text-sm text-pretty text-muted-foreground">
          Types at the cursor. Return in the terminal sends it.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="coarse:flex-1">
            Discard
          </Button>
          <Button variant="primary" size="sm" disabled={!typed} onClick={onType} className="coarse:flex-[2]">
            Type into {target}
          </Button>
        </div>
      </>,
    );
  }
  const listening = state.kind === "listening";
  const status =
    state.kind === "preparing"
      ? `Getting ${language} recognition for this device…`
      : listening
        ? `Listening · ${language}`
        : `Transcribing for ${target}…`;
  return frame(
    <>
      <p className="flex items-center justify-between px-1 text-sm text-muted-foreground">
        <span role="status">{status}</span>
        {state.kind === "preparing" ? null : (
          <span aria-hidden className="tabular-nums">
            {clock(state.seconds)}
          </span>
        )}
      </p>
      <div className="flex items-center gap-2">
        <IconButton label="Cancel dictation" icon={<X />} size="md" onClick={onCancel} />
        <span className="flex min-h-(--control) min-w-0 flex-1 items-center gap-2.5 rounded-md bg-raised px-2.5 py-1">
          {listening ? (
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              <Mic aria-hidden className="size-4 text-foreground" />
              <span
                aria-hidden
                data-voice-heard={state.heard}
                className={cn(
                  "absolute -top-0.5 -right-0.5 size-2 rounded-full",
                  state.heard ? "animate-pulse bg-destructive motion-reduce:animate-none" : "bg-muted-foreground",
                )}
              />
            </span>
          ) : (
            <span className="flex size-4 shrink-0 items-center justify-center">
              <Spinner />
            </span>
          )}
          <span
            className={cn("line-clamp-2 min-w-0 flex-1 text-base break-words", !listening && "text-muted-foreground")}
          >
            {listening ? state.text || "Speak now" : "Turning speech into text"}
          </span>
        </span>
        {state.kind === "preparing" ? null : (
          <Button variant="primary" size="md" loading={!listening} onClick={onStop}>
            <Square aria-hidden className="fill-current" />
            Done
          </Button>
        )}
      </div>
    </>,
  );
}
