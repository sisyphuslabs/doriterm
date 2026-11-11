import { describe, expect, test } from "bun:test";
import { DisplayGate, GLITCH_REPAIR_MININTERVAL, sendInterval } from "./prediction-display.ts";
import { confirmed, harness } from "./testing/prediction-harness.ts";

/** One cull at an SRTT, through the same formula the predictor uses. */
const at = (gate: DisplayGate, srtt: number, active = false): DisplayGate => {
  gate.update(sendInterval(srtt), active);
  return gate;
};

describe("sendInterval (mosh transportsender-impl.h:61-68)", () => {
  test("is ceil(srtt / 2) clamped to [20, 250], and 250 before any sample", () => {
    const srtts = [undefined, 0, 35, 40, 41, 60, 61, 100, 101, 160, 161, 499, 501];
    expect(srtts.map(sendInterval)).toEqual([250, 20, 20, 20, 21, 30, 31, 50, 51, 80, 81, 250, 250]);
  });
});

describe("the display triggers at their boundaries, in srtt: on above 60, off at 40, flag above 160, unflag at 100", () => {
  test("drawn from srtt 61, not at 60", () => {
    expect(at(new DisplayGate(), 60).shows("adaptive")).toBe(false);
    expect(at(new DisplayGate(), 61).shows("adaptive")).toBe(true);
  });

  test("once on, kept down to srtt 41; off at 40 only while no prediction is outstanding", () => {
    const gate = at(new DisplayGate(), 61);
    expect(at(gate, 41).shows("adaptive")).toBe(true);
    expect(at(gate, 40, true).shows("adaptive")).toBe(true);
    expect(at(gate, 40).shows("adaptive")).toBe(false);
  });

  test("srtt 35 never draws predictions: the misport compared srtt itself with 30", () => {
    expect(at(new DisplayGate(), 35).shows("adaptive")).toBe(false);
    expect(at(at(new DisplayGate(), 61), 35).shows("adaptive")).toBe(false);
  });

  test("underlined from srtt 161, not at 160; once on, kept at 101 and off at 100", () => {
    expect(at(new DisplayGate(), 160).underlined).toBe(false);
    const gate = at(new DisplayGate(), 161);
    expect(gate.underlined).toBe(true);
    expect(at(gate, 101).underlined).toBe(true);
    expect(at(gate, 100).underlined).toBe(false);
  });

  test("a prediction outstanding 250 ms draws even on a fast link; ten spaced quick confirmations repair it", () => {
    const gate = at(new DisplayGate(), 10);
    gate.pending(249);
    expect(gate.shows("adaptive")).toBe(false);
    gate.pending(250);
    expect(gate.shows("adaptive")).toBe(true);
    gate.confirmed(100, GLITCH_REPAIR_MININTERVAL);
    gate.confirmed(100, GLITCH_REPAIR_MININTERVAL + 1);
    for (let repair = 2; repair <= 9; repair += 1) gate.confirmed(100, GLITCH_REPAIR_MININTERVAL * repair);
    expect(gate.shows("adaptive")).toBe(true);
    gate.confirmed(100, GLITCH_REPAIR_MININTERVAL * 10);
    expect(gate.shows("adaptive")).toBe(false);
  });

  test("a prediction outstanding 5 s underlines; `never` and `always` override the triggers", () => {
    const gate = new DisplayGate();
    gate.pending(5000);
    expect(at(gate, 10).underlined).toBe(true);
    expect([gate.shows("never"), new DisplayGate().shows("always")]).toEqual([false, true]);
  });
});

describe("the predictor's adaptive display", () => {
  test("a LAN that echoes in 10 ms never draws; a relay that echoes in 300 ms draws, underlined", () => {
    const lan = harness();
    lan.link.mode = "adaptive";
    lan.predictor.typed("l", "key");
    lan.clock.now += 10;
    lan.hostEchoes("l");
    lan.predictor.typed("s", "key");
    expect(lan.predictor.visible()).toEqual([]);
    const relay = harness();
    relay.link.mode = "adaptive";
    relay.predictor.typed("l", "key");
    relay.clock.now += 300;
    relay.hostEchoes("l");
    relay.predictor.typed("s", "key");
    expect([relay.predictor.visible().map((cell) => cell.text), relay.predictor.underlined]).toEqual([["s"], true]);
    const always = harness();
    confirmed(always);
    always.predictor.typed("s", "key");
    expect(always.predictor.visible().map((cell) => cell.text)).toEqual(["s"]);
  });

  test("an echo at loopback speed never draws; the same link stalling 250 ms draws, whatever its path (#2003)", () => {
    const own = harness();
    own.link.mode = "adaptive";
    own.predictor.typed("l", "key");
    own.clock.now += 1;
    own.hostEchoes("l");
    own.predictor.typed("s", "key");
    own.clock.now += 1;
    own.predictor.tick(own.clock.now);
    expect(own.predictor.visible()).toEqual([]);
    own.clock.now += 250;
    own.predictor.tick(own.clock.now);
    expect(own.predictor.visible().map((cell) => cell.text)).toEqual(["s"]);
  });
});
