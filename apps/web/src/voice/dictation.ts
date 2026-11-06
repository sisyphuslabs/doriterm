import type { VoiceError } from "@doriface/ui";
import { errorFor, type Recognizer, type RecognizerClass, type Support, type Unavailable } from "./recognizer.ts";
import { toTerminalInput, transcriptOf } from "./transcript.ts";
import type { Engine } from "./voice-settings.ts";

/**
 * idle: the mic alone. unavailable: no recognizer here, and why. consent: before the browser's speech service hears
 * anything (device: on-device recognition can be installed instead). preparing: the on-device language pack installs.
 * listening, transcribing (the speech ended or Done was pressed; the last words are owed), ready (the transcript to edit), error.
 */
export type DictationState =
  | { readonly kind: "idle" }
  | { readonly kind: "unavailable"; readonly why: Unavailable }
  | { readonly kind: "consent"; readonly device: boolean }
  | { readonly kind: "preparing" }
  | { readonly kind: "listening"; readonly since: number; readonly heard: boolean; readonly text: string }
  | { readonly kind: "transcribing"; readonly since: number }
  | { readonly kind: "ready"; readonly transcript: string }
  | { readonly kind: "error"; readonly reason: VoiceError };

export interface DictationOptions {
  readonly support: Support;
  readonly language: () => string;
  readonly engine: () => Engine;
  /** Stores the user's answer to the consent question, so it is asked once. */
  readonly remember: (engine: Engine) => void;
  /** The reason shown when the language cannot be recognized on the device: `device`, or `device-mac` on the Mac app. */
  readonly unavailableReason?: VoiceError;
  readonly now?: () => number;
}

const IDLE: DictationState = { kind: "idle" };

/**
 * One dictation into one terminal, from the mic to the transcript typed at its cursor. Audio goes only where the
 * browser's recognizer sends it, and to its speech service only once the user allowed that; nothing here keeps it.
 */
export class Dictation {
  readonly #options: DictationOptions;
  #state: DictationState = IDLE;
  readonly #listeners = new Set<() => void>();
  #session: Recognizer | null = null;
  /** Bumped by every new start, cancel and close, so an install or a session that outlived its turn changes nothing. */
  #turn = 0;

  constructor(options: DictationOptions) {
    this.#options = options;
  }

  get state(): DictationState {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The mic: listen where the user's choice allows, or ask first. */
  async start(): Promise<void> {
    const turn = this.#next();
    const { support } = this.#options;
    if (support.kind === "unavailable") return this.#set({ kind: "unavailable", why: support.why });
    const engine = this.#options.engine();
    if (engine === "service") return this.#listen(support.recognizer, false);
    if (engine === "device") return this.#onDevice(support.recognizer, turn);
    const local = await this.#localAvailability(support.recognizer);
    if (turn !== this.#turn) return undefined;
    if (local === "available") return this.#listen(support.recognizer, true);
    return this.#set({ kind: "consent", device: local !== "unavailable" && support.recognizer.install !== undefined });
  }

  /** Consent given: the browser's speech service may hear this and later dictations. */
  async allowService(): Promise<void> {
    if (this.#state.kind !== "consent" || this.#options.support.kind !== "ok") return;
    this.#options.remember("service");
    this.#next();
    this.#listen(this.#options.support.recognizer, false);
  }

  /** Consent declined in favour of the device: install its language pack, then listen there only. */
  async keepOnDevice(): Promise<void> {
    if (this.#state.kind !== "consent" || this.#options.support.kind !== "ok") return;
    this.#options.remember("device");
    await this.#onDevice(this.#options.support.recognizer, this.#next());
  }

  /** Done: no more audio; the recognizer still delivers its last words, then the session ends. */
  stop(): void {
    if (this.#state.kind !== "listening") return;
    this.#set({ kind: "transcribing", since: this.#state.since });
    this.#session?.stop();
  }

  /** Cancel: drop the audio and every word heard; nothing is offered or typed. */
  cancel(): void {
    this.close();
  }

  /** Back to the mic alone from any state, ending a session or an install still under way. */
  close(): void {
    this.#next();
    const session = this.#session;
    this.#session = null;
    session?.abort();
    this.#set(IDLE);
  }

  edit(transcript: string): void {
    if (this.#state.kind === "ready") this.#set({ kind: "ready", transcript });
  }

  /** The edited transcript as text to type at the cursor, or null when there is none; back to the mic either way. */
  take(): string | null {
    const typed = this.#state.kind === "ready" ? toTerminalInput(this.#state.transcript) : "";
    if (this.#state.kind === "ready") this.#set(IDLE);
    return typed === "" ? null : typed;
  }

  #next(): number {
    this.#turn += 1;
    return this.#turn;
  }

  #set(state: DictationState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  async #localAvailability(recognizer: RecognizerClass): Promise<string> {
    if (recognizer.available === undefined) return "unavailable";
    const options = { langs: [this.#options.language()], processLocally: true };
    return recognizer.available(options).catch(() => "unavailable");
  }

  async #onDevice(recognizer: RecognizerClass, turn: number): Promise<void> {
    const local = await this.#localAvailability(recognizer);
    if (turn !== this.#turn) return;
    if (local === "available") return this.#listen(recognizer, true);
    const unavailable = this.#options.unavailableReason ?? "device";
    if (local === "unavailable" || recognizer.install === undefined)
      return this.#set({ kind: "error", reason: unavailable });
    this.#set({ kind: "preparing" });
    const options = { langs: [this.#options.language()], processLocally: true };
    const installed = await recognizer.install(options).catch(() => false);
    if (turn !== this.#turn) return;
    if (installed) return this.#listen(recognizer, true);
    return this.#set({ kind: "error", reason: unavailable });
  }

  #listen(Recognizer: RecognizerClass, local: boolean): void {
    const session = new Recognizer();
    session.lang = this.#options.language();
    // One utterance: the recognizer ends the session itself when the speech ends (#194 Q5), with no timer of our own.
    session.continuous = false;
    session.interimResults = true;
    if (local) session.processLocally = true;
    let text = "";
    let failure: VoiceError | null = null;
    const current = () => this.#session === session;
    session.addEventListener("speechstart", () => {
      if (current() && this.#state.kind === "listening") this.#set({ ...this.#state, heard: true });
    });
    // The utterance is over: no more audio is taken, and the last words are still on their way.
    session.addEventListener("speechend", () => {
      if (current() && this.#state.kind === "listening") this.#set({ kind: "transcribing", since: this.#state.since });
    });
    session.addEventListener("result", (event) => {
      if (!current()) return;
      text = transcriptOf(Reflect.get(event, "results"));
      if (this.#state.kind === "listening") this.#set({ ...this.#state, heard: true, text });
    });
    session.addEventListener("error", (event) => {
      const code: unknown = Reflect.get(event, "error");
      failure = errorFor(typeof code === "string" ? code : "", local) ?? failure;
    });
    session.addEventListener("end", () => {
      if (!current()) return;
      this.#session = null;
      const transcript = text.trim();
      if (failure !== null) return this.#set({ kind: "error", reason: failure });
      return this.#set(transcript === "" ? { kind: "error", reason: "no-speech" } : { kind: "ready", transcript });
    });
    this.#session = session;
    this.#set({ kind: "listening", since: (this.#options.now ?? Date.now)(), heard: false, text: "" });
    try {
      session.start();
    } catch (cause) {
      if (!(cause instanceof DOMException)) throw cause;
      this.#session = null;
      this.#set({ kind: "error", reason: "service" });
    }
  }
}
