import { bridgeMethod } from "../desktop/bridge.ts";
import type { LocalAvailability, Recognizer, RecognizerClass, RecognizerOptions } from "./recognizer.ts";

/**
 * The macOS desktop app's recognizer (#726): the system's own, on this Mac only, run by the app's main process. The
 * page never captures audio; it starts and stops a session and hears its events.
 */
export interface DesktopDictation {
  /** Whether this Mac can recognize `lang` on the device. */
  available(lang: string): Promise<boolean>;
  /** A session id, or why none started (`mic-system`, `speech-system`, `device-mac`, `busy`, `service`). */
  start(lang: string): Promise<{ readonly session: number } | { readonly refused: string }>;
  stop(session: number): void;
  abort(session: number): void;
  /** Calls `listener` with every session event the shell sends this page. */
  onEvent(listener: (event: DesktopDictationEvent) => void): void;
}

export type DesktopDictationEvent =
  | { readonly session: number; readonly kind: "speechstart" | "speechend" | "end" }
  | { readonly session: number; readonly kind: "result"; readonly text: string; readonly final: boolean }
  | { readonly session: number; readonly kind: "error"; readonly code: string };

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** One event from the shell, checked: the page treats the bridge as an untrusted boundary. */
export function parseDictationEvent(value: unknown): DesktopDictationEvent | null {
  const session = field(value, "session");
  const kind = field(value, "kind");
  if (typeof session !== "number" || !Number.isSafeInteger(session)) return null;
  if (kind === "speechstart" || kind === "speechend" || kind === "end") return { session, kind };
  if (kind === "result") {
    const text = field(value, "text");
    const final = field(value, "final");
    return typeof text === "string" && typeof final === "boolean" ? { session, kind, text, final } : null;
  }
  if (kind === "error") {
    const code = field(value, "code");
    return typeof code === "string" ? { session, kind, code } : null;
  }
  return null;
}

const report = (what: string) => (error: unknown) => console.error(`dictation ${what}: ${String(error)}`);
const settle = (result: unknown, what: string): void => {
  if (result instanceof Promise) result.catch(report(what));
};

/** The shell's dictation, or null outside the desktop app or in a build without it (Windows, Linux, no addon). */
export function desktopDictation(scope: object = globalThis): DesktopDictation | null {
  const available = bridgeMethod("dictationAvailable", scope);
  const start = bridgeMethod("dictationStart", scope);
  const stop = bridgeMethod("dictationStop", scope);
  const abort = bridgeMethod("dictationAbort", scope);
  const onEvent = bridgeMethod("onDictationEvent", scope);
  if (available === null || start === null || stop === null || abort === null || onEvent === null) return null;
  return {
    available: async (lang) => (await available(lang)) === true,
    start: async (lang) => {
      const answer: unknown = await start(lang);
      const session = field(answer, "session");
      if (typeof session === "number" && Number.isSafeInteger(session)) return { session };
      const refused = field(answer, "refused");
      return { refused: typeof refused === "string" ? refused : "service" };
    },
    stop: (session) => settle(stop(session), "stop"),
    abort: (session) => settle(abort(session), "abort"),
    onEvent: (listener) =>
      void onEvent((value: unknown) => {
        const event = parseDictationEvent(value);
        if (event !== null) listener(event);
      }),
  };
}

const emit = (target: EventTarget, type: string, fields: Record<string, unknown> = {}): void => {
  target.dispatchEvent(Object.assign(new Event(type), fields));
};

/**
 * The shell's sessions as the page's `Recognizer`: the same events a browser recognizer fires, so `Dictation` drives it
 * unchanged. Always on the device; there is nothing to install.
 */
export function desktopRecognizer(shell: DesktopDictation): RecognizerClass {
  const live = new Map<number, DesktopRecognizer>();
  shell.onEvent((event) => live.get(event.session)?.hear(event));

  class DesktopRecognizer extends EventTarget implements Recognizer {
    lang = "";
    continuous = false;
    interimResults = true;
    processLocally = true;
    #session: number | null = null;
    #stopping = false;
    #done = false;

    start(): void {
      void this.#open();
    }

    stop(): void {
      if (this.#session === null) this.#stopping = true;
      else shell.stop(this.#session);
    }

    /** Ends the session now; like a browser recognizer, it reports `aborted` and then ends. */
    abort(): void {
      if (this.#done) return;
      if (this.#session !== null) shell.abort(this.#session);
      this.#finish("aborted");
    }

    hear(event: DesktopDictationEvent): void {
      if (this.#done) return;
      if (event.kind === "result") {
        const result = Object.assign([{ transcript: event.text, confidence: 1 }], { isFinal: event.final });
        emit(this, "result", { resultIndex: 0, results: [result] });
      } else if (event.kind === "error") emit(this, "error", { error: event.code });
      else if (event.kind === "end") this.#finish(null);
      else emit(this, event.kind);
    }

    async #open(): Promise<void> {
      const answer = await shell.start(this.lang).catch(() => ({ refused: "service" }));
      if (this.#done) {
        if ("session" in answer) shell.abort(answer.session);
        return;
      }
      if ("refused" in answer) return this.#finish(answer.refused);
      this.#session = answer.session;
      live.set(answer.session, this);
      emit(this, "start");
      if (this.#stopping) shell.stop(answer.session);
    }

    #finish(error: string | null): void {
      this.#done = true;
      if (this.#session !== null) live.delete(this.#session);
      if (error !== null) emit(this, "error", { error });
      emit(this, "end");
    }
  }

  const available = async (options: RecognizerOptions): Promise<LocalAvailability> => {
    const lang = options.langs[0];
    if (lang === undefined) return "unavailable";
    return (await shell.available(lang).catch(() => false)) ? "available" : "unavailable";
  };
  return Object.assign(DesktopRecognizer, { available });
}
