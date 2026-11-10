import { describe, expect, test } from "bun:test";
import {
  type DesktopDictation,
  type DesktopDictationEvent,
  desktopDictation,
  desktopRecognizer,
  parseDictationEvent,
} from "./desktop-recognizer.ts";
import { Dictation, type DictationState } from "./dictation.ts";
import { errorFor } from "./recognizer.ts";

class Shell implements DesktopDictation {
  readonly unavailableReason = "device-mac";
  onDevice = true;
  answer: { readonly session: number } = { session: 1 };
  readonly starts: string[] = [];
  readonly stops: number[] = [];
  readonly aborts: number[] = [];
  #listener: ((event: DesktopDictationEvent) => void) | null = null;
  async available(): Promise<boolean> {
    return this.onDevice;
  }
  #replies: ((answer: { readonly session: number } | { readonly refused: string }) => void)[] = [];
  start(lang: string) {
    this.starts.push(lang);
    return new Promise<{ readonly session: number } | { readonly refused: string }>((resolve) => {
      this.#replies.push(resolve);
    });
  }
  /** Answers the oldest start still waiting with `answer`. */
  reply(answer: { readonly session: number } | { readonly refused: string } = this.answer): void {
    this.#replies.shift()?.(answer);
  }
  stop(session: number): void {
    this.stops.push(session);
  }
  abort(session: number): void {
    this.aborts.push(session);
  }
  onEvent(listener: (event: DesktopDictationEvent) => void): void {
    this.#listener = listener;
  }
  send(event: DesktopDictationEvent): void {
    this.#listener?.(event);
  }
}

const desktop = (shell: Shell) => {
  const remembered: string[] = [];
  const made: EventTarget[] = [];
  class Recorded extends desktopRecognizer(shell) {
    constructor() {
      super();
      made.push(this);
    }
  }
  const dictation = new Dictation({
    support: { kind: "ok", recognizer: Recorded },
    language: () => "ko-KR",
    engine: () => "device",
    remember: (engine) => void remembered.push(engine),
    unavailableReason: "device-mac",
    now: () => 1_000,
  });
  /** The shell answers the start; resolves once the recognizer opened its session (its `start` event). */
  const open = (answer?: { readonly session: number }): Promise<void> => {
    const recognizer = made.at(-1);
    if (recognizer === undefined) throw new Error("no recognizer was made");
    const opened = new Promise<void>((resolve) =>
      recognizer.addEventListener("start", () => resolve(), { once: true }),
    );
    shell.reply(answer);
    return opened;
  };
  return { dictation, remembered, open };
};

/** Resolves once `dictation` is in a state that satisfies `done`, subscribed before the step that gets it there. */
const until = (dictation: Dictation, done: (state: DictationState) => boolean): Promise<DictationState> =>
  new Promise((resolve) => {
    if (done(dictation.state)) return resolve(dictation.state);
    const stop = dictation.subscribe(() => {
      if (!done(dictation.state)) return;
      stop();
      resolve(dictation.state);
    });
  });

describe("the macOS app's dictation through the system recognizer", () => {
  test("it listens on the device at once: no consent question, nothing remembered", async () => {
    const shell = new Shell();
    const { dictation, remembered } = desktop(shell);
    await dictation.start();
    expect(dictation.state.kind).toBe("listening");
    expect(remembered).toEqual([]);
    expect(shell.starts).toEqual(["ko-KR"]);
  });

  test("a language this Mac cannot recognize ends in device-mac, never in the consent question", async () => {
    const shell = new Shell();
    shell.onDevice = false;
    const { dictation } = desktop(shell);
    await dictation.start();
    expect(dictation.state).toEqual({ kind: "error", reason: "device-mac" });
    expect(shell.starts).toEqual([]);
  });

  test.each(["mic-system", "speech-system", "device-mac", "mic-windows", "device-windows"] as const)(
    "a start refused with %s shows that reason, and Try again starts afresh",
    async (refused) => {
      const shell = new Shell();
      const { dictation, open } = desktop(shell);
      await dictation.start();
      const failed = until(dictation, (state) => state.kind === "error");
      shell.reply({ refused });
      expect(await failed).toEqual({ kind: "error", reason: refused });
      await dictation.start();
      await open({ session: 2 });
      expect(dictation.state.kind).toBe("listening");
    },
  );

  test("a busy shell reads as the service refusing", async () => {
    const busy = new Shell();
    const { dictation } = desktop(busy);
    await dictation.start();
    const failed = until(dictation, (state) => state.kind === "error");
    busy.reply({ refused: "busy" });
    expect(await failed).toEqual({ kind: "error", reason: "service" });
  });

  test("the session's words become the transcript; another session's events change nothing", async () => {
    const shell = new Shell();
    const { dictation, open } = desktop(shell);
    await dictation.start();
    await open();
    shell.send({ session: 9, kind: "result", text: "not mine", final: true });
    shell.send({ session: 1, kind: "speechstart" });
    shell.send({ session: 1, kind: "result", text: "git status", final: false });
    expect(dictation.state).toEqual({ kind: "listening", since: 1_000, heard: true, text: "git status" });
    shell.send({ session: 1, kind: "speechend" });
    expect(dictation.state.kind).toBe("transcribing");
    shell.send({ session: 1, kind: "result", text: "git status.", final: true });
    shell.send({ session: 1, kind: "end" });
    expect(dictation.state).toEqual({ kind: "ready", transcript: "git status." });
  });

  test("Done ends the audio in the shell; Cancel ends the session there and drops its words", async () => {
    const shell = new Shell();
    const { dictation, open } = desktop(shell);
    await dictation.start();
    await open();
    dictation.stop();
    expect(shell.stops).toEqual([1]);
    dictation.cancel();
    expect(shell.aborts).toEqual([1]);
    shell.send({ session: 1, kind: "result", text: "late", final: true });
    expect(dictation.state).toEqual({ kind: "idle" });
  });

  test("Cancel before the shell answers ends that session as soon as it exists", async () => {
    const shell = new Shell();
    const aborted = Promise.withResolvers<number>();
    shell.abort = (session) => aborted.resolve(session);
    const { dictation } = desktop(shell);
    await dictation.start();
    dictation.cancel();
    shell.reply({ session: 4 });
    expect(await aborted.promise).toBe(4);
  });
});

describe("the bridge boundary", () => {
  test("the shell's dictation exists only when the bridge offers every method", () => {
    const full = {
      dictationAvailable: () => true,
      dictationStart: () => ({ session: 1 }),
      dictationStop: () => true,
      dictationAbort: () => true,
      onDictationEvent: () => undefined,
    };
    expect(desktopDictation({ doriface: full })).not.toBeNull();
    expect(desktopDictation({ doriface: { ...full, platform: "win32" } })?.unavailableReason).toBe("device-windows");
    expect(desktopDictation({ doriface: { ...full, onDictationEvent: undefined } })).toBeNull();
    expect(desktopDictation({})).toBeNull();
  });

  test("only well-formed events are heard", () => {
    expect(parseDictationEvent({ session: 1, kind: "end" })).toEqual({ session: 1, kind: "end" });
    expect(parseDictationEvent({ session: 1, kind: "error", code: "mic-system" })).toEqual({
      session: 1,
      kind: "error",
      code: "mic-system",
    });
    for (const bad of [null, { session: "1", kind: "end" }, { session: 1, kind: "result", text: 2, final: true }]) {
      expect(parseDictationEvent(bad)).toBeNull();
    }
  });

  test("the system's reasons pass through as they are; a busy shell reads as the service refusing", () => {
    expect(errorFor("mic-system", true)).toBe("mic-system");
    expect(errorFor("speech-system", true)).toBe("speech-system");
    expect(errorFor("device-mac", true)).toBe("device-mac");
    expect(errorFor("busy", true)).toBe("service");
    expect(errorFor("not-allowed", false)).toBe("permission");
  });
});
