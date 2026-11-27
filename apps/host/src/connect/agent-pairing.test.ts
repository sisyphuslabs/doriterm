import { buildPairingDeepLink, createPairingOffer, generateHostIdentity, PAIRING_TTL_MS } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { DIAL_TIMEOUT_MS, dialBoundOf } from "../commands/connect.ts";
import { linkOf, pairingHost, runSession } from "../testing/pairing-harness.ts";
import { awaitPairingAnswer } from "./dial.ts";
import { parseTarget } from "./target.ts";

/** The agent's side of an agent offer's pairing, against the real host gate, and the request its owner sees. */
async function agentWaiting() {
  const host = pairingHost({ agentOffer: true });
  const run = runSession(host, { kind: "lan" }, linkOf(host, "claude"));
  const client = await run.client;
  if (client === undefined) throw new Error("the agent's handshake failed");
  const lines: string[] = [];
  const answer = awaitPairingAnswer(client, true, (line) => lines.push(line)).then(
    () => "paired",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  const join = await host.approvals.next();
  return { host, join, lines, answer };
}

describe("doriface-host connect on an agent invite (#2939)", () => {
  test("says it waits for the owner, with the code the owner sees on the request", async () => {
    const { host, join, lines, answer } = await agentWaiting();
    expect(lines).toEqual([
      `Waiting for the owner to approve this agent in Doriterm. Compare this code there: ${join.code}`,
    ]);
    host.approvals.decide(join.nonce, false);
    await answer;
  });

  test.each([
    [
      "a denial",
      (approvals: ReturnType<typeof pairingHost>["approvals"], nonce: string) => approvals.decide(nonce, false),
    ],
    ["an expiry", (approvals: ReturnType<typeof pairingHost>["approvals"], nonce: string) => approvals.expire(nonce)],
  ])("ends on %s with a refusal that says so, which the command exits non-zero on", async (_, refuse) => {
    const { host, join, answer } = await agentWaiting();
    refuse(host.approvals, join.nonce);
    expect(await answer).toContain("the owner denied this agent, or no one approved it before the invite ended");
    expect(host.deps.devices.list()).toEqual([]);
  });

  test("an agent invite may wait the offer's whole life; anything else keeps the dial bound", () => {
    const identity = generateHostIdentity();
    const link = (agent: boolean) =>
      buildPairingDeepLink({
        hostId: identity.hostId,
        noiseStaticPub: identity.noise.publicKey,
        signPub: identity.sign.publicKey,
        linkSecret: createPairingOffer().linkSecret,
        relayUrl: "wss://relay.example",
        agent,
      });
    expect(dialBoundOf(parseTarget(link(true)))).toBe(PAIRING_TTL_MS);
    expect(dialBoundOf(parseTarget(link(false)))).toBe(DIAL_TIMEOUT_MS);
    expect(dialBoundOf(parseTarget(identity.hostId))).toBe(DIAL_TIMEOUT_MS);
  });
});
