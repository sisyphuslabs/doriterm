import { PAIRING_CODE_ATTEMPTS, PAIRING_TTL_MS, pairingSlotOf } from "@doriface/crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PairingSlotRegistrar, PairingSlots } from "./pairing-slots.ts";
import { PairingStore } from "./state/pairing.ts";

const KEY = new Uint8Array(32);
let dir: string;
let store: PairingStore;
let slots: PairingSlots | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-slots-"));
  store = new PairingStore(dir);
});
afterEach(() => {
  slots?.stop();
  slots = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function within<T>(promise: Promise<T>, what: string, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen`)), ms)),
  ]);
}

/** A registrar that reports each call and answers when the test says so. */
function controlledRegistrar() {
  const asked = Promise.withResolvers<string>();
  const answer = Promise.withResolvers<"registered" | "collision">();
  const released = Promise.withResolvers<string>();
  const registrar: PairingSlotRegistrar = {
    register: (slot) => {
      asked.resolve(slot);
      return answer.promise;
    },
    release: (slot) => released.resolve(slot),
  };
  return { registrar, asked: asked.promise, answer, released: released.promise };
}

describe("PairingSlots", () => {
  test("an offer whose slot is unavailable is still removed when it expires", async () => {
    store.offer(Date.now() - PAIRING_TTL_MS + 100);
    const removed = Promise.withResolvers<void>();
    store.onChange(() => {
      if (store.read() === undefined) removed.resolve();
    });
    slots = new PairingSlots(store, KEY, undefined, () => {});
    slots.start();
    await within(removed.promise, "expiry");
  });

  test("a registration that answers after stop() is released, not kept", async () => {
    const offer = store.offer();
    const relay = controlledRegistrar();
    slots = new PairingSlots(store, KEY, relay.registrar, () => {});
    slots.start();
    await within(relay.asked, "register");
    slots.stop();
    relay.answer.resolve("registered");
    expect(await within(relay.released, "release")).toBe(pairingSlotOf(offer.code));
  });

  test("concurrent opens each get their own offer, registered before it is returned", async () => {
    const registered: string[] = [];
    const registrar: PairingSlotRegistrar = {
      register: async (slot) => {
        await new Promise((resolve) => setImmediate(resolve));
        registered.push(slot);
        return "registered";
      },
      release: () => {},
    };
    slots = new PairingSlots(store, KEY, registrar, () => {});
    slots.start();
    const [a, b] = await Promise.all([slots.open(), slots.open()]);
    expect(a.code).not.toBe(b.code);
    expect([a.slot, b.slot]).toEqual(["registered", "registered"]);
    expect(registered).toContain(pairingSlotOf(a.code));
    expect(store.read()?.code).toBe(b.code);
  });

  test("the registrar is given the offer's expiry, which the uplink signs with the slot and key", async () => {
    const offer = store.offer();
    const signedExpiry = Promise.withResolvers<number>();
    const registrar: PairingSlotRegistrar = {
      register: async (_slot, _key, expiresAt) => {
        signedExpiry.resolve(expiresAt);
        return "registered";
      },
      release: () => {},
    };
    slots = new PairingSlots(store, KEY, registrar, () => {});
    slots.start();
    expect(await within(signedExpiry.promise, "register")).toBe(offer.expiresAt);
  });

  test("a registration the relay failed is tried again", async () => {
    store.offer();
    let calls = 0;
    const second = Promise.withResolvers<void>();
    const registrar: PairingSlotRegistrar = {
      register: () => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("uplink down"));
        second.resolve();
        return Promise.resolve("registered");
      },
      release: () => {},
    };
    slots = new PairingSlots(store, KEY, registrar, () => {}, 10);
    slots.start();
    await within(second.promise, "a second registration");
    expect(calls).toBe(2);
  });

  test("a code whose attempts are spent has its relay slot released", async () => {
    const offer = store.offer();
    const relay = controlledRegistrar();
    slots = new PairingSlots(store, KEY, relay.registrar, () => {});
    slots.start();
    await within(relay.asked, "register");
    const registered = Promise.withResolvers<void>();
    store.onChange(() => {
      if (store.read()?.slot === "registered") registered.resolve();
    });
    relay.answer.resolve("registered");
    await within(registered.promise, "registration");
    const slot = pairingSlotOf(offer.code);
    for (let attempt = 0; attempt < PAIRING_CODE_ATTEMPTS; attempt++) store.claimCode(slot);
    expect(await within(relay.released, "release")).toBe(slot);
  });

  test("an offer an earlier host process registered is registered again", async () => {
    const offer = store.offer();
    store.setSlot(offer.code, "registered");
    const relay = controlledRegistrar();
    slots = new PairingSlots(store, KEY, relay.registrar, () => {});
    slots.start();
    expect(await within(relay.asked, "register")).toBe(pairingSlotOf(offer.code));
  });
});
