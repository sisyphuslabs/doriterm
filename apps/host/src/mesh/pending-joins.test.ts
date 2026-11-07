import { describe, expect, test } from "bun:test";
import { type PendingJoin, PendingJoins } from "./pending-joins.ts";

const join = (nonce: string): PendingJoin => ({
  nonce,
  name: "beta",
  noisePub: "noise-beta",
  hostId: "host",
  kind: "machine",
  fingerprint: "3FA9",
  expiresAt: Date.now() + 60_000,
});

describe("pending joins (section 4.3)", () => {
  test("expireAll expires every pending join, and none is offered any more", async () => {
    const pending = new PendingJoins();
    const asked = [pending.ask(join("a")), pending.ask(join("b"))];
    pending.expireAll();
    expect(await Promise.all(asked)).toEqual(["expired", "expired"]);
    expect(pending.list()).toEqual([]);
  });

  test("a next whose signal aborts rejects with its reason and stops watching", async () => {
    const pending = new PendingJoins();
    const controller = new AbortController();
    const waiting = pending.next(controller.signal);
    expect(pending.watching).toBe(1);
    controller.abort(new Error("the control connection closed"));
    expect(
      await waiting.then(
        () => "joined",
        (error: unknown) => String(error),
      ),
    ).toContain("connection closed");
    expect(pending.watching).toBe(0);
  });
});
