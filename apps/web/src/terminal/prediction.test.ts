import { describe, expect, test } from "bun:test";
import { EchoRtt, EXPIRE_FLOOR_MS, expiryMs } from "./prediction-timing.ts";
import { confirmed, harness, judgements } from "./testing/prediction-harness.ts";

const texts = (h: ReturnType<typeof harness>): string[] => h.predictor.visible().map((cell) => cell.text);

/** The host writes `text` at a cell without the cursor following, as a redraw elsewhere on the row would. */
const hostWritesAt = (h: ReturnType<typeof harness>, col: number, text: string): void => {
  const cursor = h.screen.at;
  h.screen.at = { row: cursor.row, col };
  h.screen.echo(text);
  h.screen.at = cursor;
  h.predictor.wrote();
};

describe("the echo round trip (seeded by the first confirmation, RFC 6298)", () => {
  test("the first sample R is srtt R and rttvar R/2; later samples take the 1/8 and 1/4 gains", () => {
    const rtt = new EchoRtt();
    expect(rtt.estimate).toBeUndefined();
    rtt.sample(300);
    expect(rtt.estimate).toEqual({ srtt: 300, rttvar: 150 });
    rtt.sample(500);
    expect(rtt.estimate).toEqual({ srtt: 325, rttvar: 162.5 });
  });

  test("expiry is the RTO, srtt + 4 * rttvar, never under the RFC's one-second floor", () => {
    expect(expiryMs(undefined)).toBe(EXPIRE_FLOOR_MS);
    expect(expiryMs({ srtt: 300, rttvar: 150 })).toBe(1000);
    expect(expiryMs({ srtt: 800, rttvar: 100 })).toBe(1200);
  });

  test("nothing seeds it before a key is echoed, and the echo that confirms the first key does", () => {
    const h = harness();
    h.predictor.typed("a", "key");
    h.clock.now += 300;
    h.predictor.tick(h.clock.now);
    expect(h.predictor.roundTrip).toBeUndefined();
    h.hostEchoes("a");
    expect(h.predictor.roundTrip).toEqual({ srtt: 300, rttvar: 150 });
    expect(h.events).toEqual([{ kind: "confirmed", latencyMs: 300 }]);
  });
});

describe("judgement: time may confirm or expire, never call a prediction wrong (#1439 HIGH 1)", () => {
  test("a drawn key whose cell shows something else stays drawn until expiry, however late, then goes", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    hostWritesAt(h, 1, "x");
    h.clock.now += 999;
    h.predictor.tick(h.clock.now);
    expect([texts(h), judgements(h)]).toEqual([["a"], []]);
    h.predictor.tick(h.clock.now + 1);
    expect([texts(h), judgements(h)]).toEqual([[], ["reset:expired"]]);
  });

  test("a later key's echo proves the earlier key answered: a cell showing something else is wrong at once", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.predictor.typed("b", "key");
    hostWritesAt(h, 1, "x");
    expect(judgements(h)).toEqual([]);
    hostWritesAt(h, 2, "b");
    expect([texts(h), judgements(h)]).toEqual([[], ["reset:incorrect"]]);
  });

  test("an undrawn key judged wrong kills its epoch without a reset: nothing on screen vanishes", () => {
    const h = harness();
    h.predictor.typed("a", "key");
    h.predictor.typed("b", "key");
    hostWritesAt(h, 0, "x");
    hostWritesAt(h, 1, "b");
    expect(judgements(h)).toEqual(["killEpoch:incorrect"]);
    h.predictor.typed("c", "key");
    expect(texts(h)).toEqual([]);
  });

  test("a confirmed epoch whose keys echo late, out to just under expiry, never resets", () => {
    const h = harness();
    confirmed(h);
    for (const key of "late") {
      h.predictor.typed(key, "key");
      h.clock.now += 70;
      h.predictor.tick(h.clock.now);
    }
    h.clock.now += 700;
    h.predictor.tick(h.clock.now);
    expect(texts(h)).toEqual(["l", "a", "t", "e"]);
    h.hostEchoes("late");
    expect([texts(h), judgements(h)]).toEqual([[], []]);
  });

  test("a wide prediction is confirmed by the wide cell the host writes", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("가", "key");
    h.predictor.typed("a", "key");
    expect(texts(h)).toEqual(["가", "a"]);
    h.hostEchoes("가");
    expect(h.predictor.visible()).toEqual([{ row: 0, col: 3, text: "a", width: 1 }]);
  });

  test("bytes are read as UTF-8: one key as bytes is predicted like the same key as text", () => {
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed(new TextEncoder().encode("가"), "key")).toMatchObject({ cell: { text: "가", width: 2 } });
  });
});

describe("matches that prove no echo (mosh CorrectNoCredit)", () => {
  test("a space matching a blank cell never confirms an epoch", () => {
    const h = harness();
    h.predictor.typed(" ", "key");
    h.hostEchoes(" ");
    h.predictor.typed("a", "key");
    expect(texts(h)).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test("it holds the predicted cursor until answered, so a host write in between does not move the next key", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed(" ", "key");
    h.predictor.wrote();
    expect(h.predictor.typed("-", "key")).toMatchObject({ kind: "predicted", cell: { col: 2 } });
    h.hostEchoes(" -");
    expect([texts(h), judgements(h)]).toEqual([[], []]);
  });

  test("a key over a cell that already shows it goes at expiry without a judgement", () => {
    const h = harness();
    h.screen.echo("ab");
    h.screen.at = { row: 0, col: 0 };
    h.predictor.typed("a", "key");
    h.predictor.wrote();
    h.clock.now += 1000;
    h.predictor.tick(h.clock.now);
    expect([h.predictor.visible(), h.events]).toEqual([[], []]);
  });
});

describe("the cursor leaving the row of undrawn predictions", () => {
  test("after a clear moves the cursor up, undrawn predictions on the old row are dropped and the next key predicts from the real cursor (#1439 LOW)", () => {
    const h = harness();
    h.screen.at = { row: 10, col: 0 };
    confirmed(h, "a");
    expect(h.predictor.typed("\f", "key")).toEqual({ kind: "refused", rule: "P1" });
    h.predictor.typed("b", "key");
    h.predictor.typed("c", "key");
    h.screen.at = { row: 0, col: 2 };
    h.predictor.wrote();
    expect([judgements(h), h.predictor.visible()]).toEqual([["killEpoch:row-left"], []]);
    expect(h.predictor.typed("d", "key")).toMatchObject({ kind: "predicted", cell: { row: 0, col: 2 } });
  });

  test("a prediction the wrap placed on the next row survives wrote() while the cursor is still on the wrapping row", () => {
    const h = harness();
    h.screen.at = { row: 3, col: 78 };
    confirmed(h);
    h.predictor.typed("a", "key");
    expect(h.predictor.typed("b", "key")).toMatchObject({ kind: "predicted", cell: { row: 4, col: 0 } });
    h.predictor.typed("c", "key");
    h.predictor.wrote();
    expect([h.screen.cursor(), judgements(h)]).toEqual([{ row: 3, col: 79 }, []]);
    expect(h.predictor.typed("d", "key")).toMatchObject({ kind: "predicted", cell: { row: 4, col: 2 } });
    h.hostEchoes("ab");
    expect([texts(h), judgements(h)]).toEqual([["c", "d"], []]);
  });

  test("after a clear moves the cursor above a wrap, the predictions the wrap carried below are dropped too, and the next key predicts from the real cursor", () => {
    const h = harness();
    h.screen.at = { row: 10, col: 76 };
    confirmed(h, "x");
    h.predictor.typed("a", "key");
    h.predictor.typed("b", "key");
    h.predictor.typed("c", "key");
    expect(h.predictor.typed("d", "key")).toMatchObject({ kind: "predicted", cell: { row: 11, col: 0 } });
    // The host echoes the keys on the wrapping row: only the wrap's own prediction on row 11 is left undrawn.
    h.hostEchoes("abc");
    expect(h.predictor.typed("\f", "key")).toEqual({ kind: "refused", rule: "P1" });
    h.screen.at = { row: 0, col: 1 };
    h.predictor.wrote();
    expect(judgements(h)).toEqual(["killEpoch:row-left"]);
    expect(h.predictor.typed("e", "key")).toMatchObject({ kind: "predicted", cell: { row: 0, col: 1 } });
  });

  test("predictions the wrap carried two rows ahead of the cursor also wait for the host to get there", () => {
    const h = harness();
    h.screen.at = { row: 3, col: 78 };
    confirmed(h);
    h.predictor.typed("a", "key");
    for (let col = 0; col < 80; col += 1) h.predictor.typed("x", "key");
    expect(h.predictor.typed("y", "key")).toMatchObject({ kind: "predicted", cell: { row: 5, col: 0 } });
    h.predictor.wrote();
    expect([h.screen.cursor(), judgements(h)]).toEqual([{ row: 3, col: 79 }, []]);
  });
});

describe("visible()", () => {
  test("returns the same array until the predictions change, so a renderer can skip an unchanged frame", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    const first = h.predictor.visible();
    h.predictor.tick(h.clock.now + 1);
    expect(h.predictor.visible()).toBe(first);
    h.predictor.typed("b", "key");
    expect(h.predictor.visible()).not.toBe(first);
  });
});
