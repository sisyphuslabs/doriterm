import { agentPairingCode, CloseCode } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { linkOf, pairingHost, runSession } from "../testing/pairing-harness.ts";

/** An agent offer redeemed over its link: the request the owner is asked about, and the session that waits on it. */
async function agentAsks() {
  const host = pairingHost({ agentOffer: true });
  const run = runSession(host, { kind: "lan" }, linkOf(host, "claude"));
  const join = await host.approvals.next();
  return { host, run, join };
}

describe("an agent offer's pairing waits for an owner (#2939)", () => {
  test("is a pending request, never a device, until an owner answers", async () => {
    const { host, join } = await agentAsks();
    expect(join).toMatchObject({ kind: "agent", name: "claude", joinerConfirmed: true });
    expect(join.expiresAt).toBe(host.offer.expiresAt);
    expect(host.deps.devices.list()).toEqual([]);
    // The offer is spent as the handshake confirms: a second party cannot pair on it while this one waits.
    expect(host.pairing.read()).toBeUndefined();
  });

  test("the code the owner compares is the one the agent computes from the same handshake", async () => {
    const { run, join } = await agentAsks();
    const client = await run.client;
    if (client === undefined) throw new Error("the agent's handshake failed");
    expect(join.code).toBe(agentPairingCode(client.handshakeHash));
  });

  test("a waiting agent has no session, so it reads none of this host's documents, the joins one included", async () => {
    const { run } = await agentAsks();
    const settled = await Promise.race([run.host.then(() => "session"), Promise.resolve("waiting")]);
    expect(settled).toBe("waiting");
  });

  test("an approval stores the device and lets the session go on", async () => {
    const { host, run, join } = await agentAsks();
    expect(host.approvals.decide(join.nonce, true, join.code)).toBe(true);
    expect(await run.host).toBeDefined();
    expect(host.deps.devices.list().map((device) => device.name)).toEqual(["claude"]);
  });

  test("a denial closes the session with its reason and leaves no device", async () => {
    const { host, run, join } = await agentAsks();
    const closed = new Promise<{ code: number | undefined; reason: string | undefined }>((resolve) => {
      run.clientEnd.onClose((error) =>
        resolve({ code: (error as { code?: number } | undefined)?.code, reason: error?.message }),
      );
    });
    expect(host.approvals.decide(join.nonce, false)).toBe(true);
    expect(await run.host).toBeUndefined();
    expect(await closed).toMatchObject({ code: CloseCode.UnknownDevice });
    expect(host.deps.devices.list()).toEqual([]);
    expect(host.logs.some((line) => line.includes("the owner denied this agent"))).toBe(true);
  });

  test("an expiry ends the request with the offer and leaves no device", async () => {
    const { host, run, join } = await agentAsks();
    // The same settle the offer's expiry timer runs (PendingJoins), driven here instead of waiting ten minutes.
    expect(host.approvals.expire(join.nonce)).toBe(true);
    expect(await run.host).toBeUndefined();
    expect(host.deps.devices.list()).toEqual([]);
    expect(host.logs.some((line) => line.includes("no owner approved this agent"))).toBe(true);
  });

  test("an agent that hangs up ends its request: an owner then has nothing to approve", async () => {
    const { host, run, join } = await agentAsks();
    run.clientEnd.close();
    expect(await run.host).toBeUndefined();
    expect(host.approvals.list()).toEqual([]);
    expect(host.approvals.decide(join.nonce, true, join.code)).toBe(false);
    expect(host.deps.devices.list()).toEqual([]);
  });

  test("a device offer still pairs at once, with no request", async () => {
    const host = pairingHost();
    const run = runSession(host, { kind: "lan" }, linkOf(host, "phone"));
    expect(await run.host).toBeDefined();
    expect(host.approvals.list()).toEqual([]);
    expect(host.deps.devices.list().map((device) => device.name)).toEqual(["phone"]);
  });
});
