import { describe, expect, spyOn, test } from "bun:test";
import { type PendingJoin, PendingJoins } from "./pending-joins.ts";

const join = (nonce: string): PendingJoin => ({
  nonce,
  name: "beta",
  noisePub: "noise-beta",
  hostId: "host",
  kind: "machine",
  fingerprint: "3FA9",
  code: "123 456",
  joinerConfirmed: false,
  expiresAt: Date.now() + 60_000,
});

test.each(["approve-first", "confirm-first"] as const)("both confirmations are required in %s order", async (order) => {
  const pending = new PendingJoins();
  const asked = pending.ask(join("a"));
  if (order === "approve-first") pending.decide("a", true, "123 456");
  else pending.confirm("a");
  expect(pending.list()).toHaveLength(1);
  expect(pending.list()[0]?.joinerConfirmed).toBe(order === "confirm-first");
  if (order === "approve-first") pending.confirm("a");
  else pending.decide("a", true, "123 456");
  expect(await asked).toBe("approved");
  expect(pending.list()).toEqual([]);
});

test("missing and wrong approval codes cannot approve, while denial needs none", async () => {
  const pending = new PendingJoins();
  const asked = pending.ask(join("a"));
  expect(() => pending.decide("a", true)).toThrow("update this client to approve");
  expect(() => pending.decide("a", true, "987 654")).toThrow("code");
  expect(pending.list()).toHaveLength(1);
  expect(pending.decide("a", false)).toBe(true);
  expect(await asked).toBe("denied");
});

test("auto never approves a client and no pending join can lack its code", async () => {
  const pending = new PendingJoins();
  pending.setAuto(Date.now() + 60_000);
  const asked = pending.ask({ ...join("client"), kind: "client" });
  pending.confirm("client");
  expect(pending.list()).toHaveLength(1);
  expect(() => pending.ask({ ...join("bad"), code: "" })).toThrow("code");
  pending.decide("client", false);
  expect(await asked).toBe("denied");
});

test.each(["approve", "confirm"] as const)("a late %s cannot beat an expired join's timer", async (last) => {
  const pending = new PendingJoins();
  const card = join("late");
  const result = pending.ask(card);
  if (last === "approve") pending.confirm(card.nonce);
  else pending.decide(card.nonce, true, card.code);
  const clock = spyOn(Date, "now").mockReturnValue(card.expiresAt);
  try {
    expect(last === "approve" ? pending.decide(card.nonce, true, card.code) : pending.confirm(card.nonce)).toBe(false);
    expect(await result).toBe("expired");
    expect(pending.list()).toEqual([]);
  } finally {
    clock.mockRestore();
    pending.expireAll();
  }
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
