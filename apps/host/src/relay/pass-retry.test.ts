import { describe, expect, test } from "bun:test";
import { RelayCloseError, type RelayProofs } from "@doriface/relay-client";
import { withPassRetry } from "./pass-retry.ts";

const RELAY = "https://relay.example";

function fakeProofs(): { proofs: RelayProofs; renew: () => void; subscribed: Promise<void> } {
  const listeners = new Set<(origin: string) => void>();
  const subscribed = Promise.withResolvers<void>();
  let usable = true;
  const proofs: RelayProofs = {
    presents: () => usable,
    proof: () => undefined,
    received: () => undefined,
    refused: () => {
      usable = false;
    },
    accepted: () => undefined,
    wantsPass: () => true,
    onWant: () => () => undefined,
    onPass: (listener) => {
      listeners.add(listener);
      subscribed.resolve();
      return () => listeners.delete(listener);
    },
  };
  return {
    proofs,
    renew: () => listeners.forEach((listener) => listener("wss://relay.example")),
    subscribed: subscribed.promise,
  };
}

function dials(...outcomes: (number | "ok")[]): { dial: () => Promise<string>; count: () => number } {
  let calls = 0;
  return {
    count: () => calls,
    dial: async () => {
      const outcome = outcomes[calls++];
      if (outcome === "ok") return `link ${calls}`;
      throw new RelayCloseError(outcome ?? 1011, "closed");
    },
  };
}

describe("a dial refused for its pass (contract v1.6, 3.6)", () => {
  test("a 4412 on a dial that carried no proof is an ordinary failure: no redial, nothing marked", async () => {
    const { proofs } = fakeProofs();
    proofs.refused("wss://relay.example");
    const once = dials(4412, "ok");
    const error = await withPassRetry(once.dial, proofs, RELAY, 1).catch((caught: unknown) => caught);
    expect(error instanceof RelayCloseError ? error.code : error).toBe(4412);
    expect(once.count()).toBe(1);
  });

  test("marks the pass refused and redials once as soon as the new pass arrives", async () => {
    const { proofs, renew, subscribed } = fakeProofs();
    const { dial, count } = dials(4412, "ok");
    const result = withPassRetry(dial, proofs, RELAY, 60_000);
    await subscribed;
    expect(proofs.presents("wss://relay.example")).toBe(false);
    renew();
    expect(await result).toBe("link 2");
    expect(count()).toBe(2);
  });

  test("redials once after the wait when no pass came, and a 4429 then is reported as the 4412", async () => {
    const { proofs } = fakeProofs();
    const { dial, count } = dials(4412, 4429);
    const error = await withPassRetry(dial, proofs, RELAY, 1).catch((caught: unknown) => caught);
    expect(error instanceof RelayCloseError ? error.code : error).toBe(4412);
    expect(count()).toBe(2);
  });

  test("other failures of the redial, and every failure that is not a 4412, pass through untouched", async () => {
    const { proofs } = fakeProofs();
    const offline = await withPassRetry(dials(4412, 4404).dial, proofs, RELAY, 1).catch((caught: unknown) => caught);
    expect(offline instanceof RelayCloseError ? offline.code : offline).toBe(4404);
    const once = dials(4429);
    const limited = await withPassRetry(once.dial, proofs, RELAY, 1).catch((caught: unknown) => caught);
    expect(limited instanceof RelayCloseError ? limited.code : limited).toBe(4429);
    expect(once.count()).toBe(1);
  });
});
