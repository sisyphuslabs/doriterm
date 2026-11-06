import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PUSH_PREFS,
  encodePushLine,
  parsePushClientLine,
  parsePushHostLine,
  parsePushNotice,
  PushLineError,
} from "./push.ts";

const HOST = "abcdefghijklmnopqrstuvwxyz";
const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const SUB = {
  endpoint: "https://push.example/send/abc",
  p256dh: "B".repeat(87),
  auth: "C".repeat(22),
};

describe("a push payload", () => {
  test("is exactly v, n, k and h", () => {
    expect(parsePushNotice({ v: 1, n: ID, k: "permission", h: HOST })).toEqual({
      v: 1,
      n: ID,
      k: "permission",
      h: HOST,
    });
  });

  test.each([
    ["an extra member (a title)", { v: 1, n: ID, k: "done", h: HOST, title: "deploy" }],
    ["a missing host", { v: 1, n: ID, k: "done" }],
    ["an unknown kind", { v: 1, n: ID, k: "other", h: HOST }],
    ["a short notice id", { v: 1, n: "abc", k: "done", h: HOST }],
    ["another version", { v: 2, n: ID, k: "done", h: HOST }],
  ])("is refused with %s", (_, value) => {
    expect(parsePushNotice(value)).toBeUndefined();
  });
});

describe("push stream lines", () => {
  test("a subscribe round-trips through the encoder", () => {
    const line = { t: "subscribe", subscription: SUB, prefs: DEFAULT_PUSH_PREFS } as const;
    expect(parsePushClientLine(encodePushLine(line).trimEnd())).toEqual(line);
  });

  test("an unknown t is a line the host answers, not one it closes on", () => {
    expect(parsePushClientLine('{"t":"later"}')).toEqual({ t: "unknown" });
  });

  test.each([
    ["not JSON", "hello"],
    ["no t", '{"x":1}'],
    [
      "a short auth secret",
      JSON.stringify({ t: "subscribe", subscription: { ...SUB, auth: "C" }, prefs: DEFAULT_PUSH_PREFS }),
    ],
    ["a non-http endpoint", JSON.stringify({ t: "unsubscribe", endpoint: "file:///etc/passwd" })],
    ["an answer other than allow or deny", JSON.stringify({ t: "answer", id: ID, answer: "always" })],
    ["a line of 4096 bytes", JSON.stringify({ t: "focus", terminal: "t".repeat(4090) })],
    ["a row that is no row number", JSON.stringify({ t: "choose", id: ID, option: "esc" })],
  ])("closes on %s", (_, line) => {
    expect(() => parsePushClientLine(line)).toThrow(PushLineError);
  });

  test("a row of a notice's prompt round-trips", () => {
    const line = { t: "choose", id: ID, option: "2" } as const;
    expect(parsePushClientLine(encodePushLine(line).trimEnd())).toEqual(line);
  });

  test("a notice names its prompt's rows; malformed rows are dropped and long labels cut", () => {
    const line = {
      t: "notice",
      terminal: "t3",
      kind: "input",
      prompt: {
        options: [
          { id: "1", label: "Postgres", declines: false },
          { id: "esc", label: "not a row" },
          { id: "2", label: "x".repeat(200), declines: true },
        ],
      },
    };
    expect(parsePushHostLine(JSON.stringify(line))).toEqual({
      t: "notice",
      terminal: "t3",
      kind: "input",
      prompt: {
        options: [
          { id: "1", label: "Postgres", declines: false },
          { id: "2", label: "x".repeat(80), declines: true },
        ],
      },
    });
    expect(parsePushHostLine('{"t":"notice","terminal":"t3","kind":"input","prompt":{"options":[]}}')).toEqual({
      t: "notice",
      terminal: "t3",
      kind: "input",
    });
  });

  test("host lines parse for the app", () => {
    expect(parsePushHostLine('{"t":"stale","terminal":"box/t3"}')).toEqual({ t: "stale", terminal: "box/t3" });
    expect(parsePushHostLine('{"t":"failed","terminal":"t3","reason":"link dropped"}')).toEqual({
      t: "failed",
      terminal: "t3",
      reason: "link dropped",
    });
    expect(parsePushHostLine('{"t":"unknown","terminal":"t3"}')).toEqual({ t: "unknown", terminal: "t3" });
    expect(parsePushHostLine('{"t":"notice","terminal":null,"kind":null}')).toEqual({
      t: "notice",
      terminal: null,
      kind: null,
    });
  });
});
