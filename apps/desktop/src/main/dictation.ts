import {
  Channel,
  type DictationEvent,
  type DictationStartAnswer,
  isDictationEvent,
  isDictationLanguage,
} from "../shared/bridge.ts";

/** The native addon: macOS Speech or Windows SAPI, on the device only, in this process. */
export interface SpeechAddon {
  /** Whether this app's Info.plist carries both usage strings; without them macOS would end the app on a request. */
  ready(): boolean;
  speechStatus(): string;
  requestSpeech(): Promise<string>;
  supportsOnDevice(lang: string): boolean;
  /** Starts the one session (ending any other) and answers its id; its events arrive through `onEvent`. */
  start(lang: string, onEvent: (event: unknown) => void): number;
  stop(session: number): void;
  abort(session: number): void;
}

/** The microphone's system permission, read and asked through Electron's `systemPreferences`. */
export interface Microphone {
  status(): string;
  ask(): Promise<boolean>;
}

/** The page that started a session: only it hears the session's events. */
export interface DictationOwner {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface Current {
  readonly session: number;
  readonly owner: DictationOwner;
}

/**
 * One dictation at a time for the whole app, owned by the page that started it. The page captures no audio: it asks
 * here, the system prompts for the microphone and for speech recognition, and the addon records and recognizes on this
 * Mac. A session ends with its page (`dropOwner`) and with the app (`stopAll`); a late event of an ended one is dropped.
 */
export class DictationHost {
  readonly #addon: SpeechAddon;
  readonly #microphone: Microphone;
  readonly #platform: "darwin" | "win32";
  #current: Current | null = null;
  /** The page waiting on the system's prompts; a reload, navigation or close while they are open cancels its start. */
  #pending: { readonly ownerId: number; dropped: boolean } | null = null;

  constructor(addon: SpeechAddon, microphone: Microphone, platform: "darwin" | "win32" = "darwin") {
    this.#addon = addon;
    this.#microphone = microphone;
    this.#platform = platform;
  }

  available(lang: unknown): boolean {
    return isDictationLanguage(lang) && this.#addon.supportsOnDevice(lang);
  }

  async start(owner: DictationOwner, lang: unknown): Promise<DictationStartAnswer> {
    if (!isDictationLanguage(lang)) return { refused: "service" };
    if (this.#pending !== null) return { refused: "busy" };
    if (this.#current !== null && this.#current.owner.id !== owner.id) return { refused: "busy" };
    const pending = { ownerId: owner.id, dropped: false };
    this.#pending = pending;
    let refusal: DictationStartAnswer | null;
    try {
      refusal = await this.#permitted(lang);
    } finally {
      this.#pending = null;
    }
    if (refusal !== null) return refusal;
    // The page that asked is gone (reloaded, navigated, closed or quit) while the prompt was open: start nothing.
    if (pending.dropped || owner.isDestroyed()) return { refused: "service" };
    if (this.#current !== null && this.#current.owner.id !== owner.id) return { refused: "busy" };
    // The same page starting again ends its own session first; the addon runs one at a time.
    this.#end();
    try {
      const session = this.#addon.start(lang, (event) => this.#deliver(event));
      this.#current = { session, owner };
      return { session };
    } catch (error) {
      console.error(`dictation start: ${String(error)}`);
      return { refused: "service" };
    }
  }

  stop(owner: DictationOwner, session: unknown): boolean {
    const owned = this.#owned(owner, session);
    if (owned === null) return false;
    this.#addon.stop(owned.session);
    return true;
  }

  abort(owner: DictationOwner, session: unknown): boolean {
    if (this.#owned(owner, session) === null) return false;
    this.#end();
    return true;
  }

  /** The page reloaded, navigated, crashed or closed: its session ends with it. */
  dropOwner(id: number): void {
    if (this.#pending?.ownerId === id) this.#pending.dropped = true;
    if (this.#current?.owner.id === id) this.#end();
  }

  stopAll(): void {
    if (this.#pending !== null) this.#pending.dropped = true;
    this.#end();
  }

  async #permitted(lang: string): Promise<DictationStartAnswer | null> {
    const microphone = this.#microphone.status();
    if (this.#platform === "win32") {
      // Windows has a global desktop-app microphone setting, not a per-app prompt or SAPI speech permission.
      // Read it again on every start so Try again works after Settings changes without restarting the app.
      if (microphone !== "granted") return { refused: "mic-windows" };
      if (!this.#addon.supportsOnDevice(lang)) return { refused: "device-windows" };
      return null;
    }
    if (microphone === "not-determined") {
      if (!(await this.#microphone.ask())) return { refused: "mic-system" };
    } else if (microphone !== "granted") return { refused: "mic-system" };
    let speech = this.#addon.speechStatus();
    if (speech === "not-determined") speech = await this.#addon.requestSpeech();
    if (speech !== "granted") return { refused: "speech-system" };
    if (!this.#addon.supportsOnDevice(lang)) return { refused: "device-mac" };
    return null;
  }

  #owned(owner: DictationOwner, session: unknown): Current | null {
    const current = this.#current;
    return current !== null && current.owner.id === owner.id && current.session === session ? current : null;
  }

  #end(): void {
    const current = this.#current;
    this.#current = null;
    if (current !== null) this.#addon.abort(current.session);
  }

  #deliver(event: unknown): void {
    const current = this.#current;
    if (!isDictationEvent(event) || current === null || event.session !== current.session) return;
    if (current.owner.isDestroyed()) return this.#end();
    current.owner.send(Channel.dictationEvent, copyEvent(event));
    if (event.kind === "end") this.#current = null;
  }
}

/** Only the fields an event has, so nothing else the addon put on the object reaches the page. */
function copyEvent(event: DictationEvent): DictationEvent {
  if (event.kind === "result") return { session: event.session, kind: "result", text: event.text, final: event.final };
  if (event.kind === "error") return { session: event.session, kind: "error", code: event.code };
  return { session: event.session, kind: event.kind };
}
