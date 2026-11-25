import type { SonioxKey } from "../vault/mesh-vault.ts";
import type { Recognizer, RecognizerClass } from "./recognizer.ts";

export interface SonioxSocket extends EventTarget {
  send(data: string | Blob): void;
  close(): void;
}

/** The parts of a MediaRecorder this recognizer uses: compressed audio chunks, which Soniox reads with `auto`. */
export interface SonioxRecorder extends EventTarget {
  start(timeslice: number): void;
  stop(): void;
}

export interface SonioxDeps {
  /** The key from the mesh vault, opened in memory for this one session; undefined when this device cannot open it. */
  readonly key: () => Promise<SonioxKey | undefined>;
  readonly socket: (url: string, protocols: readonly string[]) => SonioxSocket;
  readonly recorder: () => Promise<SonioxRecorder>;
}

/** Whether a host is Soniox's own: the key in the vault is only ever sent there, whoever wrote the Base URL. */
export const isSonioxHost = (host: string): boolean => host === "soniox.com" || host.endsWith(".soniox.com");

/** Soniox's real-time endpoint for a Base URL: `api.soniox.com` streams at `stt-rt.soniox.com`; https only. */
export function sonioxSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("the Soniox Base URL must be https");
  if (!isSonioxHost(url.hostname)) throw new Error("the Soniox Base URL must be a soniox.com address");
  const host = url.host === "api.soniox.com" ? "stt-rt.soniox.com" : url.host;
  return `wss://${host}/transcribe-websocket`;
}

const CHUNK_MS = 250;
/** Soniox control tokens (endpoint, manual finalization), not words. */
const CONTROL = /^<\w+>$/;

const emit = (target: EventTarget, type: string, fields: Record<string, unknown> = {}): void => {
  target.dispatchEvent(Object.assign(new Event(type), fields));
};

/** A Soniox error type as the Web Speech API's code, which `errorFor` turns into the strip's reason. */
function codeFor(errorType: unknown): string {
  if (errorType === "unauthenticated" || errorType === "invalid_request") return "not-allowed";
  if (errorType === "max_concurrent_connections_reached") return "busy";
  return "network";
}

interface Token {
  readonly text: string;
  readonly final: boolean;
}

function tokensOf(value: unknown): readonly Token[] {
  const tokens: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "tokens") : undefined;
  if (!Array.isArray(tokens)) return [];
  return tokens.flatMap((token: unknown) => {
    const text: unknown = typeof token === "object" && token !== null ? Reflect.get(token, "text") : undefined;
    const final: unknown = typeof token === "object" && token !== null ? Reflect.get(token, "is_final") : undefined;
    return typeof text === "string" && !CONTROL.test(text) ? [{ text, final: final === true }] : [];
  });
}

/**
 * Dictation through Soniox: the device opens Soniox's WebSocket itself with the key from the mesh vault (in the protocols
 * list, never in a message), records compressed audio and streams it; audio and key never pass through Doriterm. It fires
 * the events a browser recognizer fires, so `Dictation` drives it unchanged.
 */
export function sonioxRecognizer(deps: SonioxDeps): RecognizerClass {
  return class SonioxRecognizer extends EventTarget implements Recognizer {
    lang = "";
    continuous = true;
    interimResults = true;
    #socket: SonioxSocket | null = null;
    #recorder: SonioxRecorder | null = null;
    #final = "";
    #heard = false;
    #done = false;
    #stopping = false;

    start(): void {
      void this.#open().catch(() => this.#finish("network"));
    }

    stop(): void {
      this.#stopping = true;
      this.#recorder?.stop();
      // An empty text frame ends the stream; Soniox answers with the last tokens and `finished`, then closes.
      this.#socket?.send("");
    }

    abort(): void {
      this.#finish("aborted");
    }

    async #open(): Promise<void> {
      const key = await deps.key();
      if (this.#done) return;
      if (key === undefined || key.apiKey === "") return this.#finish("service-not-allowed");
      const socket = deps.socket(sonioxSocketUrl(key.baseUrl), ["soniox-api-key", key.apiKey]);
      this.#socket = socket;
      socket.addEventListener("message", (event) => this.#hear(Reflect.get(event, "data")));
      socket.addEventListener("error", () => this.#finish("network"));
      socket.addEventListener("close", () => this.#finish(null));
      await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }));
      if (this.#done) return;
      const language = this.lang.split("-")[0] ?? "";
      const hints = language === "" ? {} : { language_hints: [language] };
      socket.send(JSON.stringify({ model: key.model, audio_format: "auto", ...hints }));
      const recorder = await deps.recorder();
      if (this.#done) return recorder.stop();
      this.#recorder = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        const data: unknown = Reflect.get(event, "data");
        if (data instanceof Blob && data.size > 0 && !this.#done) socket.send(data);
      });
      recorder.start(CHUNK_MS);
      emit(this, "start");
      if (this.#stopping) this.stop();
    }

    #hear(data: unknown): void {
      if (this.#done || typeof data !== "string") return;
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch (cause) {
        if (cause instanceof SyntaxError) return;
        throw cause;
      }
      const errorType: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, "error_type") : undefined;
      if (errorType !== undefined) return this.#finish(codeFor(errorType));
      const tokens = tokensOf(value);
      let interim = "";
      for (const token of tokens) {
        if (token.final) this.#final += token.text;
        else interim += token.text;
      }
      if (tokens.length > 0) {
        if (!this.#heard) emit(this, "speechstart");
        this.#heard = true;
        const results = [
          Object.assign([{ transcript: this.#final, confidence: 1 }], { isFinal: true }),
          Object.assign([{ transcript: interim, confidence: 1 }], { isFinal: false }),
        ];
        emit(this, "result", { resultIndex: 0, results });
      }
      if (typeof value === "object" && value !== null && Reflect.get(value, "finished") === true) this.#finish(null);
    }

    #finish(error: string | null): void {
      if (this.#done) return;
      this.#done = true;
      this.#recorder?.stop();
      this.#socket?.close();
      if (error !== null) emit(this, "error", { error });
      emit(this, "end");
    }
  };
}
