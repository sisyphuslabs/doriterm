import { describe, expect, test } from "bun:test";
import { transcriptOf } from "./transcript.ts";
import { sonioxRecognizer, sonioxSocketUrl, type SonioxSocket } from "./soniox-recognizer.ts";

class FakeSocket extends EventTarget implements SonioxSocket {
  readonly sent: (string | Blob)[] = [];
  closed = false;
  readonly url: string;
  readonly protocols: readonly string[];
  constructor(url: string, protocols: readonly string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string | Blob): void {
    this.sent.push(data);
    this.dispatchEvent(new Event("sent"));
  }
  close(): void {
    this.closed = true;
  }
  answer(value: unknown): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(value) }));
  }
}

class FakeRecorder extends EventTarget {
  stopped = false;
  start(): void {}
  stop(): void {
    this.stopped = true;
  }
  chunk(): void {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["audio"]) }));
  }
}

const KEY = { apiKey: "sk-test", model: "stt-rt-v6", baseUrl: "https://api.soniox.com" };

function rig({ key }: { readonly key: typeof KEY | undefined } = { key: KEY }) {
  const sockets: FakeSocket[] = [];
  const { promise: started, resolve: configured } = Promise.withResolvers<FakeSocket>();
  const recorder = new FakeRecorder();
  const Recognizer = sonioxRecognizer({
    key: async () => key,
    socket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      socket.addEventListener("sent", () => configured(socket), { once: true });
      queueMicrotask(() => socket.dispatchEvent(new Event("open")));
      return socket;
    },
    recorder: async () => recorder,
  });
  const session = new Recognizer();
  session.lang = "ko-KR";
  const events: { type: string; text?: string; error?: unknown }[] = [];
  for (const type of ["start", "speechstart", "result", "error", "end"])
    session.addEventListener(type, (event) =>
      events.push({ type, text: transcriptOf(Reflect.get(event, "results")), error: Reflect.get(event, "error") }),
    );
  const ended = new Promise<void>((resolve) => session.addEventListener("end", () => resolve()));
  return { session, sockets, recorder, events, ended, started };
}

describe("Soniox dictation", () => {
  test("connects with the key in the protocols list (never the start message) and streams to a transcript", async () => {
    const { session, recorder, events, ended, started } = rig();
    const recording = new Promise((resolve) => session.addEventListener("start", resolve, { once: true }));
    session.start();
    const socket = await started;
    await recording;
    expect(socket.url).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(socket.protocols).toEqual(["soniox-api-key", "sk-test"]);
    const start = JSON.parse(String(socket.sent[0]));
    expect(start).toEqual({ model: "stt-rt-v6", audio_format: "auto", language_hints: ["ko"] });
    expect(String(socket.sent[0])).not.toContain("sk-test");

    recorder.chunk();
    expect(socket.sent[1]).toBeInstanceOf(Blob);
    socket.answer({
      tokens: [
        { text: "안녕", is_final: true },
        { text: "하세", is_final: false },
      ],
    });
    socket.answer({
      tokens: [
        { text: "하세요", is_final: true },
        { text: "<end>", is_final: true },
      ],
    });
    session.stop();
    expect(recorder.stopped).toBe(true);
    expect(socket.sent.at(-1)).toBe("");
    socket.answer({ tokens: [], finished: true });
    await ended;
    expect(events.map((event) => event.type)).toEqual(["start", "speechstart", "result", "result", "end"]);
    expect(events.filter((event) => event.type === "result").map((event) => event.text)).toEqual([
      "안녕하세",
      "안녕하세요",
    ]);
  });

  test("a Soniox error frame ends the session with an error, and no key means no connection", async () => {
    const failing = rig();
    failing.session.start();
    const socket = await failing.started;
    socket.answer({ error_code: 401, error_type: "unauthenticated", error_message: "bad key" });
    await failing.ended;
    expect(failing.events.find((event) => event.type === "error")?.error).toBe("not-allowed");

    const keyless = rig({ key: undefined });
    keyless.session.start();
    await keyless.ended;
    expect(keyless.sockets).toEqual([]);
    expect(keyless.events.find((event) => event.type === "error")?.error).toBe("service-not-allowed");
  });

  test("the socket address follows the Base URL, only on Soniox's own https hosts", () => {
    expect(sonioxSocketUrl("https://api.soniox.com")).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(sonioxSocketUrl("https://stt-rt.eu.soniox.com/")).toBe("wss://stt-rt.eu.soniox.com/transcribe-websocket");
    expect(() => sonioxSocketUrl("http://api.soniox.com")).toThrow("https");
    expect(() => sonioxSocketUrl("https://stt.example.eu/")).toThrow("soniox.com");
    expect(() => sonioxSocketUrl("https://evilsoniox.com/")).toThrow("soniox.com");
  });
});
