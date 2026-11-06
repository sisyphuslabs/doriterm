import type { PushClientLine, PushHostLine } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { exchangeWithin, type PushExchange } from "./over-push.ts";

const failing = () => Promise.reject(new Error("notifications are off on this device"));
const NOTICE: PushClientLine = { t: "notice", id: "AAAAAAAAAAAAAAAAAAAAAA" };

/** A session whose opening the test finishes by hand, recording what it was asked and whether it was closed. */
function session(reply: Promise<PushHostLine>) {
  const opened = Promise.withResolvers<PushExchange>();
  const seen = { asked: [] as PushClientLine[], closed: false };
  const exchange: PushExchange = {
    request: (line) => (seen.asked.push(line), reply),
    close: () => void (seen.closed = true),
  };
  return { open: () => opened.promise, finishOpening: () => opened.resolve(exchange), seen };
}

describe("one line over the push stream, inside its deadline", () => {
  test("a reply inside the deadline is the answer, and the session is closed", async () => {
    const s = session(Promise.resolve({ t: "notice", terminal: "t3", kind: "input" }));
    const deadline = Promise.withResolvers<never>();
    const answered = exchangeWithin(s.open, NOTICE, deadline.promise);
    s.finishOpening();
    expect(await answered).toEqual({ t: "notice", terminal: "t3", kind: "input" });
    expect(s.seen.asked).toEqual([NOTICE]);
    expect(s.seen.closed).toBe(true);
  });

  test("the deadline covers opening the link: a link still opening when it passes is no answer", async () => {
    const s = session(Promise.resolve({ t: "ok" }));
    const deadline = Promise.withResolvers<never>();
    const answered = exchangeWithin(s.open, NOTICE, deadline.promise);
    deadline.reject(new Error("the host did not answer"));
    await expect(answered).rejects.toThrow("the host did not answer");
    // The link opens afterwards: nothing is asked on it, and it is closed at once.
    s.finishOpening();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.seen.asked).toEqual([]);
    expect(s.seen.closed).toBe(true);
  });

  test("a link that cannot open is the failure, not a hang", async () => {
    const deadline = Promise.withResolvers<never>();
    await expect(exchangeWithin(failing, NOTICE, deadline.promise)).rejects.toThrow(
      "notifications are off on this device",
    );
  });
});
