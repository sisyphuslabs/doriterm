import { describe, expect, test } from "bun:test";
import { harness } from "./testing/prediction-harness.ts";

const shown = (h: ReturnType<typeof harness>): string[] => h.predictor.visible().map((cell) => cell.text);

/**
 * What carries the session decides nothing about prediction; what the echo measures does (mosh's gate). The same
 * `adaptive` setting draws nothing where the echo lands within a frame (this computer's host, a LAN) and draws where it
 * takes a few round trips (the relay) or stalls (a loaded host), whichever transport the keys travel.
 */
describe("adaptive predictions follow the measured echo, not the link", () => {
  test.each([
    ["an echo within a frame, as this computer's host answers", 5, false],
    ["a LAN's echo", 20, false],
    ["the relay's echo", 120, true],
  ])("after %s (%p ms) the next key is drawn: %p", (_, echoMs, drawn) => {
    const h = harness();
    h.link.mode = "adaptive";
    h.predictor.typed("a", "key");
    h.clock.now += echoMs;
    h.hostEchoes("a");
    h.predictor.typed("b", "key");
    h.predictor.tick(h.clock.now);
    expect(shown(h)).toEqual(drawn ? ["b"] : []);
  });

  test("a host that stalls draws predictions even when its earlier echoes were quick (mosh's glitch trigger)", () => {
    const h = harness();
    h.link.mode = "adaptive";
    h.predictor.typed("a", "key");
    h.clock.now += 5;
    h.hostEchoes("a");
    h.predictor.typed("b", "key");
    h.clock.now += 300;
    h.predictor.tick(h.clock.now);
    expect(shown(h)).toEqual(["b"]);
  });
});
