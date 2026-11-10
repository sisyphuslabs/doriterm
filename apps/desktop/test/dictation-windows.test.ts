import { describe, expect, test } from "bun:test";
import { DictationHost, type DictationOwner, type SpeechAddon } from "../src/main/dictation.ts";
import { isDictationStartAnswer } from "../src/shared/bridge.ts";

function setup(status = "granted") {
  const calls: string[] = [];
  const addon: SpeechAddon = {
    ready: () => true,
    speechStatus: () => {
      calls.push("speech");
      return "granted";
    },
    requestSpeech: async () => "granted",
    supportsOnDevice: () => {
      calls.push("recognizer");
      return true;
    },
    start: () => {
      calls.push("start");
      return 1;
    },
    stop: () => undefined,
    abort: () => undefined,
  };
  const microphone = {
    status: () => {
      calls.push("microphone");
      return status;
    },
    ask: async () => {
      calls.push("ask");
      return false;
    },
  };
  const owner: DictationOwner = { id: 1, isDestroyed: () => false, send: () => undefined };
  return { addon, microphone, owner, calls, host: new DictationHost(addon, microphone, "win32") };
}

describe("Windows SAPI status mapping (#749)", () => {
  test.each(["denied", "restricted", "unknown", "not-determined"])(
    "%s microphone is refused before touching SAPI and never calls the macOS prompt",
    async (status) => {
      const { host, owner, calls } = setup(status);
      expect(await host.start(owner, "en-US")).toEqual({ refused: "mic-windows" });
      expect(calls).toEqual(["microphone"]);
    },
  );

  test("Try again re-reads Windows privacy and starts once desktop microphone access is on", async () => {
    const { host, owner, calls, microphone } = setup("denied");
    expect(await host.start(owner, "en-US")).toEqual({ refused: "mic-windows" });
    microphone.status = () => {
      calls.push("microphone");
      return "granted";
    };
    expect(await host.start(owner, "en-US")).toEqual({ session: 1 });
    expect(calls).toEqual(["microphone", "microphone", "recognizer", "start"]);
  });

  test("a missing SAPI recognizer refuses the requested language without starting", async () => {
    const { host, owner, addon, calls } = setup();
    addon.supportsOnDevice = () => false;
    expect(await host.start(owner, "ko-KR")).toEqual({ refused: "device-windows" });
    expect(calls).toEqual(["microphone"]);
    expect(host.available("ko-KR")).toBe(false);
  });

  test("Windows refusals cross the same validated IPC boundary", () => {
    expect(isDictationStartAnswer({ refused: "mic-windows" })).toBe(true);
    expect(isDictationStartAnswer({ refused: "device-windows" })).toBe(true);
  });
});
