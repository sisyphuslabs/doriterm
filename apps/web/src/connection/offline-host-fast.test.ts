import { base64urlEncode, generateEd25519, generateX25519, hostIdOf, rawStaticKey } from "@doriface/crypto";
import { FakeRelay, RelayClientBridge } from "@doriface/host/testing";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect } from "./connect.ts";
import { hostFailure } from "./host-failure.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

/**
 * #2004: opening a host that is not on the relay must fail fast, not after the 10 s attempt deadline. The relay closes the
 * session 4404 at once; measured at 9-105 ms. The bound is 1 s: about ten times the slowest measurement, so a loaded runner does
 * not flake it, and still a tenth of the 10 s a regression to waiting out the deadline would take.
 */
const FAST_MS = 1_000;

let relay: FakeRelay;
let bridge: RelayClientBridge;
beforeAll(() => {
  relay = new FakeRelay();
  bridge = new RelayClientBridge(relay);
});
afterAll(async () => {
  await bridge.stop();
  await relay.stop();
});

test("opening a host with no relay uplink fails within a second and says the host is not connected (#2004)", async () => {
  const device = rawStaticKey(generateX25519());
  const settings = {
    ...DEFAULT_SETTINGS,
    mode: "relay" as const,
    relayUrl: bridge.url,
    hostId: hostIdOf(generateEd25519().publicKey),
    hostKey: base64urlEncode(generateX25519().publicKey),
  };
  const startedAt = performance.now();
  const failure = await connect(
    settings,
    undefined,
    { loadDeviceKey: () => Promise.resolve(device) },
    { deadlineMs: 10_000 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const elapsed = performance.now() - startedAt;
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) return;
  expect(hostFailure(failure)).toBe(
    "Your host isn't connected right now. Check that its computer is awake and doriface-host is running.",
  );
  expect(elapsed).toBeLessThan(FAST_MS);
});
