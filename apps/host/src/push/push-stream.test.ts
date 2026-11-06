import { CloseCode } from "@doriface/crypto";
import { DEFAULT_PUSH_PREFS, encodePushLine, parsePushHostLine, type PushHostLine } from "@doriface/protocol";
import { afterEach, describe, expect, test } from "bun:test";
import { servePushStream } from "./push-stream.ts";
import { CLAUDE_QUESTION_SCREEN } from "../../../../packages/protocol/src/testing/prompt-screens.ts";
import { ENDPOINT, type Rig, rig, statusEvent, terminal } from "../testing/push-rig.ts";

const rigs: Rig[] = [];
afterEach(() => {
  for (const each of rigs.splice(0)) each.close();
});

/** One end of a push stream: lines in, reply lines out, and how it closed. */
function stream(r: Rig, owner = "device-a") {
  const replies: PushHostLine[] = [];
  let feed: ((bytes: Uint8Array) => unknown) | undefined;
  let onClose: (() => void) | undefined;
  const closed: { code?: number; reason?: string } = {};
  const waiters: ((reply: PushHostLine) => void)[] = [];
  servePushStream(
    {
      send: (bytes) => {
        const reply = parsePushHostLine(new TextDecoder().decode(bytes).trimEnd());
        replies.push(reply);
        waiters.shift()?.(reply);
      },
      onData: (handler) => {
        feed = handler;
      },
      onClose: (handler) => {
        onClose = handler;
      },
      close: (code, reason) => {
        Object.assign(closed, { code, reason });
        onClose?.();
      },
    },
    owner,
    r.service,
  );
  /** Sends one line and resolves with the host's reply to it. */
  const say = (text: string): Promise<PushHostLine> => {
    const replied = new Promise<PushHostLine>((resolve) => waiters.push(resolve));
    feed?.(new TextEncoder().encode(text));
    return replied;
  };
  /** Sends bytes the host closes on; the close happens while it reads them. */
  const send = (text: string): void => {
    feed?.(new TextEncoder().encode(text));
  };
  return { say, send, replies, closed, end: () => onClose?.() };
}

async function opened(): Promise<Rig> {
  const r = await rig();
  rigs.push(r);
  return r;
}

describe("the push stream", () => {
  test("hello is answered with the VAPID key and the device's own subscriptions only", async () => {
    const r = await opened();
    r.store.put(
      "device-b",
      { endpoint: "https://fcm.googleapis.com/other", p256dh: r.keys.p256dh, auth: r.keys.auth },
      DEFAULT_PUSH_PREFS,
    );
    const s = stream(r);
    const subscription = { endpoint: ENDPOINT, p256dh: r.keys.p256dh, auth: r.keys.auth };
    expect(await s.say(encodePushLine({ t: "subscribe", subscription, prefs: DEFAULT_PUSH_PREFS }))).toEqual({
      t: "ok",
    });
    expect(await s.say(encodePushLine({ t: "hello" }))).toEqual({
      t: "ready",
      vapidKey: r.service.vapidKey,
      subscriptions: [{ endpoint: ENDPOINT, prefs: DEFAULT_PUSH_PREFS }],
    });
  });

  test("focus holds back notices for that terminal while the stream is open", async () => {
    const r = await opened();
    r.store.put("device-a", { endpoint: ENDPOINT, p256dh: r.keys.p256dh, auth: r.keys.auth }, DEFAULT_PUSH_PREFS);
    const s = stream(r);
    expect(await s.say(encodePushLine({ t: "focus", terminal: "t1" }))).toEqual({ t: "ok" });
    await r.service.event(statusEvent("t1", { state: "done" }));
    expect(r.posted).toHaveLength(0);
    s.end();
    await r.service.event(statusEvent("t1", { state: "error" }));
    expect(r.posted).toHaveLength(1);
  });

  test("a device cannot test or change another device's subscription", async () => {
    const r = await opened();
    r.store.put("device-b", { endpoint: ENDPOINT, p256dh: r.keys.p256dh, auth: r.keys.auth }, DEFAULT_PUSH_PREFS);
    const s = stream(r);
    expect((await s.say(encodePushLine({ t: "test", endpoint: ENDPOINT })))?.t).toBe("error");
    expect((await s.say(encodePushLine({ t: "prefs", endpoint: ENDPOINT, prefs: DEFAULT_PUSH_PREFS })))?.t).toBe(
      "error",
    );
    expect(r.posted).toHaveLength(0);
  });

  test("an unknown line is answered and the stream stays; a malformed or oversized one closes it 4400", async () => {
    const r = await opened();
    const s = stream(r);
    expect(await s.say('{"t":"later"}\n')).toEqual({ t: "error", reason: "unknown line" });
    expect(s.closed.code).toBeUndefined();
    const big = stream(r);
    big.send("x".repeat(5000));
    expect(big.closed.code).toBe(CloseCode.CryptoFailure);
    const bad = stream(r);
    bad.send("[1]\n");
    expect(bad.closed.code).toBe(CloseCode.CryptoFailure);
  });
});

describe("a notice's rows on the push stream (#669)", () => {
  test("a notice names its prompt's rows, and choose answers one with its own key", async () => {
    const r = await opened();
    const subscription = { endpoint: ENDPOINT, p256dh: r.keys.p256dh, auth: r.keys.auth };
    await r.service.subscribe("device-a", subscription, DEFAULT_PUSH_PREFS);
    const asking = { state: "blocked", kind: "question", app: "claude-code" };
    r.core.terminals.set("t3", terminal("t3", asking));
    r.core.screens.set("t3", CLAUDE_QUESTION_SCREEN);
    await r.service.event(statusEvent("t3", asking));
    const [notice] = await r.notices();
    const id = typeof notice === "object" && notice !== null ? String(Reflect.get(notice, "n")) : "";
    const s = stream(r);
    expect(await s.say(encodePushLine({ t: "notice", id }))).toMatchObject({
      t: "notice",
      terminal: "t3",
      kind: "input",
      prompt: { options: [{ id: "1", label: "Postgres" }, { id: "2" }, { id: "3" }, { id: "5" }] },
    });
    expect(await s.say(encodePushLine({ t: "choose", id, option: "2" }))).toEqual({ t: "answered", terminal: "t3" });
    expect(r.core.sent).toEqual([{ terminal: "t3", keys: ["2"] }]);
  });
});
