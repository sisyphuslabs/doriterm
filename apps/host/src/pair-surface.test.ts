import { describe, expect, test } from "bun:test";
import { generateHostIdentity, generateX25519, PAIRING_TTL_MS } from "@doriface/crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairOffers } from "./pair-surface.ts";
import { DeviceStore } from "./state/devices.ts";
import { PairingStore } from "./state/pairing.ts";

const identity = generateHostIdentity();

function surface(over: { readonly now?: () => number; readonly agentWaiting?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dh-pair-surface-"));
  const pairing = new PairingStore(dir);
  const devices = new DeviceStore(dir);
  const offers = new PairOffers({
    identity,
    pairing,
    devices,
    open: async (agent: boolean) => pairing.offer(Date.now(), false, agent),
    relayUrl: "wss://relay.example",
    ...over,
  });
  return { dir, pairing, devices, offers };
}

describe("this computer's pairing offer", () => {
  test("nothing opened yet reads as none", () => {
    expect(surface().offers.state()).toEqual({ state: "none" });
  });

  test("opening answers the pending offer, and its state stays pending", async () => {
    const { offers } = surface();
    const opened = await offers.open();
    if (opened.state !== "pending") throw new Error(`opened ${opened.state}`);
    expect(opened.offer.code).toHaveLength(8);
    expect(opened.offer.link.startsWith("doriface://pair#")).toBe(true);
    const state = offers.state();
    if (state.state !== "pending") throw new Error(`state ${state.state}`);
    expect(state.offer.code).toBe(opened.offer.code);
    expect(state.offer.expiresAt).toBe(opened.offer.expiresAt);
  });

  test("an offer a device used reads as paired, naming the device", async () => {
    const { offers, pairing, devices } = surface();
    const opened = await offers.open();
    if (opened.state !== "pending") throw new Error(`opened ${opened.state}`);
    const claim = pairing.claimLink();
    if ("refused" in claim) throw new Error(`claim refused: ${claim.reason}`);
    expect(claim.complete()).toBe(true);
    const key = generateX25519().publicKey;
    devices.add(key, "Safari on iOS");
    const state = offers.state();
    if (state.state !== "paired") throw new Error(`state ${state.state}`);
    expect(state.device?.name).toBe("Safari on iOS");
    expect(state.device?.id).toMatch(/^[0-9A-F]{8}$/);
  });

  test("an agent offer whose handshake confirmed waits for approval: no device is said to be paired (#2939)", async () => {
    let waiting = true;
    const { offers, pairing } = surface({ agentWaiting: () => waiting });
    const opened = await offers.open(true);
    if (opened.state !== "pending") throw new Error(`opened ${opened.state}`);
    expect(opened.offer.link).toContain("a=1");
    const claim = pairing.claimLink();
    if ("refused" in claim) throw new Error(`claim refused: ${claim.reason}`);
    expect(claim.complete()).toBe(true);
    expect(offers.state()).toEqual({ state: "approval" });
    // Denied, expired or hung up: the request is gone and no device came, so the offer reads as ended.
    waiting = false;
    expect(offers.state()).toEqual({ state: "expired" });
  });

  test("an offer that ran out reads as expired, not as paired", async () => {
    const clock = { now: Date.now() };
    const { offers } = surface({ now: () => clock.now });
    const opened = await offers.open();
    if (opened.state !== "pending") throw new Error(`opened ${opened.state}`);
    clock.now = clock.now + PAIRING_TTL_MS + 1_000;
    expect(offers.state()).toEqual({ state: "expired" });
  });

  test("an offer a device used before any device is recorded still reads as paired", async () => {
    const { offers, pairing } = surface();
    const opened = await offers.open();
    if (opened.state !== "pending") throw new Error(`opened ${opened.state}`);
    const claim = pairing.claimLink();
    if ("refused" in claim) throw new Error(`claim refused: ${claim.reason}`);
    claim.complete();
    expect(offers.state()).toEqual({ state: "paired", device: null });
  });

  test("an offer opened earlier and then gone is paired only while it had time left", async () => {
    const clock = { now: Date.now() };
    const { offers, pairing } = surface({ now: () => clock.now });
    const opened = await offers.open();
    if (opened.state !== "pending") throw new Error(`opened ${opened.state}`);
    const claim = pairing.claimLink();
    if ("refused" in claim) throw new Error(`claim refused: ${claim.reason}`);
    claim.complete();
    clock.now = opened.offer.expiresAt + 1;
    expect(offers.state()).toEqual({ state: "expired" });
  });
});
