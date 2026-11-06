import { describe, expect, test } from "bun:test";
import { DictationHost, type DictationOwner, type Microphone, type SpeechAddon } from "../src/main/dictation.ts";
import { loadSpeech } from "../src/main/speech.ts";
import { Channel, isDictationEvent, isDictationLanguage } from "../src/shared/bridge.ts";

class Page implements DictationOwner {
  readonly sent: unknown[] = [];
  destroyed = false;
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, value: unknown): void {
    expect(channel).toBe(Channel.dictationEvent);
    this.sent.push(value);
  }
}

class Addon implements SpeechAddon {
  speech = "granted";
  speechAsked = "granted";
  onDevice = true;
  next = 1;
  readonly started: string[] = [];
  readonly stopped: number[] = [];
  readonly aborted: number[] = [];
  readonly listeners = new Map<number, (event: unknown) => void>();
  ready(): boolean {
    return true;
  }
  speechStatus(): string {
    return this.speech;
  }
  async requestSpeech(): Promise<string> {
    return this.speechAsked;
  }
  supportsOnDevice(): boolean {
    return this.onDevice;
  }
  start(lang: string, onEvent: (event: unknown) => void): number {
    const session = this.next++;
    this.started.push(lang);
    this.listeners.set(session, onEvent);
    return session;
  }
  stop(session: number): void {
    this.stopped.push(session);
  }
  abort(session: number): void {
    this.aborted.push(session);
  }
  fire(session: number, event: Record<string, unknown>): void {
    this.listeners.get(session)?.({ session, ...event });
  }
}

const mic = (status: string, answer = true): Microphone & { asks: number } => {
  const microphone = {
    asks: 0,
    status: () => status,
    ask: async () => {
      microphone.asks += 1;
      return answer;
    },
  };
  return microphone;
};

const setup = (status = "granted", answer = true) => {
  const addon = new Addon();
  const microphone = mic(status, answer);
  return { addon, microphone, host: new DictationHost(addon, microphone) };
};

describe("dictation permissions, in the system's order", () => {
  test("an undecided microphone is asked through the system; a yes starts the session", async () => {
    const { host, addon, microphone } = setup("not-determined", true);
    expect(await host.start(new Page(1), "ko-KR")).toEqual({ session: 1 });
    expect(microphone.asks).toBe(1);
    expect(addon.started).toEqual(["ko-KR"]);
  });

  test("a no, or a microphone turned off or unknown, is refused with the System Settings reason and no prompt loop", async () => {
    expect(await setup("not-determined", false).host.start(new Page(1), "en-US")).toEqual({ refused: "mic-system" });
    const off = ["denied", "restricted", "unknown"].map((status) => setup(status));
    const answers = await Promise.all(off.map(({ host }) => host.start(new Page(1), "en-US")));
    expect(answers).toEqual(off.map(() => ({ refused: "mic-system" })));
    for (const { microphone, addon } of off) {
      expect(microphone.asks).toBe(0);
      expect(addon.started).toEqual([]);
    }
  });

  test("speech recognition is asked when undecided and refused with its own reason when off", async () => {
    const asked = setup();
    asked.addon.speech = "not-determined";
    asked.addon.speechAsked = "denied";
    expect(await asked.host.start(new Page(1), "en-US")).toEqual({ refused: "speech-system" });
    const off = setup();
    off.addon.speech = "restricted";
    expect(await off.host.start(new Page(1), "en-US")).toEqual({ refused: "speech-system" });
    expect(off.addon.started).toEqual([]);
  });

  test("a language with no on-device model is refused; the audio never goes elsewhere", async () => {
    const { host, addon } = setup();
    addon.onDevice = false;
    expect(await host.start(new Page(1), "en-US")).toEqual({ refused: "device-mac" });
    expect(host.available("en-US")).toBe(false);
    expect(addon.started).toEqual([]);
  });

  test("Try again after a grant in System Settings reads the status afresh", async () => {
    let status = "denied";
    const addon = new Addon();
    const host = new DictationHost(addon, { status: () => status, ask: async () => true });
    expect(await host.start(new Page(1), "en-US")).toEqual({ refused: "mic-system" });
    status = "granted";
    expect(await host.start(new Page(1), "en-US")).toEqual({ session: 1 });
  });

  test("anything but a language tag never reaches the addon", async () => {
    const { host, addon } = setup();
    const bad = ["", "en_US", "en-US; rm", "x".repeat(40), 42, null, "../../etc"];
    const answers = await Promise.all(bad.map((lang) => host.start(new Page(1), lang)));
    expect(answers).toEqual(bad.map(() => ({ refused: "service" })));
    for (const lang of bad) expect(host.available(lang)).toBe(false);
    expect(addon.started).toEqual([]);
    expect(isDictationLanguage("zh-Hant-TW")).toBe(true);
  });
});

describe("one session, owned by the page that started it", () => {
  test("its events go to that page only, copied to their own fields", async () => {
    const { host, addon } = setup();
    const page = new Page(1);
    await host.start(page, "en-US");
    addon.fire(1, { kind: "result", text: "ls -la", final: false, extra: "dropped" });
    addon.fire(1, { kind: "end" });
    expect(page.sent).toEqual([
      { session: 1, kind: "result", text: "ls -la", final: false },
      { session: 1, kind: "end" },
    ]);
  });

  test("another page cannot start, stop or end it, and a start during a system prompt is busy", async () => {
    const { host, addon } = setup();
    const owner = new Page(1);
    const other = new Page(2);
    await host.start(owner, "en-US");
    expect(await host.start(other, "en-US")).toEqual({ refused: "busy" });
    expect(host.stop(other, 1)).toBe(false);
    expect(host.abort(other, 1)).toBe(false);
    expect(addon.stopped).toEqual([]);
    expect(addon.aborted).toEqual([]);

    const prompt = Promise.withResolvers<boolean>();
    const slow = new DictationHost(new Addon(), { status: () => "not-determined", ask: () => prompt.promise });
    const first = slow.start(owner, "en-US");
    expect(await slow.start(other, "en-US")).toEqual({ refused: "busy" });
    prompt.resolve(true);
    expect(await first).toEqual({ session: 1 });
  });

  test("the owner stops by the current session id only", async () => {
    const { host, addon } = setup();
    const page = new Page(1);
    await host.start(page, "en-US");
    expect(host.stop(page, 2)).toBe(false);
    expect(host.stop(page, 1)).toBe(true);
    expect(addon.stopped).toEqual([1]);
  });

  test("a page that starts again ends its own session first, and the old session's late events are dropped", async () => {
    const { host, addon } = setup();
    const page = new Page(1);
    await host.start(page, "en-US");
    expect(await host.start(page, "en-US")).toEqual({ session: 2 });
    expect(addon.aborted).toEqual([1]);
    addon.fire(1, { kind: "result", text: "stale", final: true });
    expect(page.sent).toEqual([]);
  });

  test("a page that reloads or navigates while the system prompt is open gets no session once it is answered", async () => {
    const prompt = Promise.withResolvers<boolean>();
    const addon = new Addon();
    const host = new DictationHost(addon, { status: () => "not-determined", ask: () => prompt.promise });
    const page = new Page(1);
    const asked = host.start(page, "en-US");
    host.dropOwner(1);
    prompt.resolve(true);
    expect(await asked).toEqual({ refused: "service" });
    expect(addon.started).toEqual([]);
    // The page that came back asks again and gets its session.
    expect(await new DictationHost(addon, mic("granted")).start(page, "en-US")).toEqual({ session: 1 });
  });

  test("quitting while the system prompt is open starts nothing", async () => {
    const prompt = Promise.withResolvers<boolean>();
    const addon = new Addon();
    const host = new DictationHost(addon, { status: () => "not-determined", ask: () => prompt.promise });
    const asked = host.start(new Page(1), "en-US");
    host.stopAll();
    prompt.resolve(true);
    expect(await asked).toEqual({ refused: "service" });
    expect(addon.started).toEqual([]);
  });

  test("a page that reloads, navigates or closes ends its session; so does quitting", async () => {
    const { host, addon } = setup();
    await host.start(new Page(1), "en-US");
    host.dropOwner(2);
    expect(addon.aborted).toEqual([]);
    host.dropOwner(1);
    expect(addon.aborted).toEqual([1]);
    await host.start(new Page(3), "en-US");
    host.stopAll();
    expect(addon.aborted).toEqual([1, 2]);
  });

  test("a destroyed owner gets nothing: its session ends at the next event", async () => {
    const { host, addon } = setup();
    const page = new Page(1);
    await host.start(page, "en-US");
    page.destroyed = true;
    addon.fire(1, { kind: "speechstart" });
    expect(page.sent).toEqual([]);
    expect(addon.aborted).toEqual([1]);
  });

  test("malformed events from the addon never reach a page", () => {
    for (const event of [
      { session: 0, kind: "end" },
      { session: 1, kind: "audio", data: [1, 2] },
      { session: 1, kind: "result", text: 5, final: true },
      { session: 1, kind: "result", text: "x".repeat(10_001), final: true },
      { session: 1, kind: "error", code: "<script>" },
    ]) {
      expect(isDictationEvent(event)).toBe(false);
    }
  });
});

describe("loading the addon", () => {
  test("an addon that is missing, malformed or lacks the usage strings leaves dictation off", () => {
    expect(
      loadSpeech("/nowhere/speech.node", () => {
        throw new Error("dlopen failed");
      }),
    ).toBeUndefined();
    expect(loadSpeech("x", () => ({ ready: () => true }))).toBeUndefined();
    const notReady = Object.assign(new Addon(), { ready: () => false });
    expect(loadSpeech("x", () => notReady)).toBeUndefined();
    const addon = new Addon();
    expect(loadSpeech("x", () => addon)).toBe(addon);
  });
});
