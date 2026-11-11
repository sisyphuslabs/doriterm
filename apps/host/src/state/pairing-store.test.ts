import { generateX25519, PAIRING_CODE_ATTEMPTS, pairingSlotOf } from "@doriface/crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitPairing } from "../e2ee/accept.ts";
import { DeviceStore } from "./devices.ts";
import { type ClaimRefusal, type PairingClaim, PairingStore } from "./pairing.ts";

const RESERVATION_WORKER = join(import.meta.dir, "..", "testing", "reservation-worker.ts");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dh-pairing-"));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function claimed(result: PairingClaim | ClaimRefusal): PairingClaim {
  if ("refused" in result) throw new Error(`refused: ${result.reason}`);
  return result;
}
const attempts = (pairing: PairingStore): number | undefined => pairing.read()?.codeAttempts;

describe("pairing consumption", () => {
  test("the offer is burned before the device is stored, so a failed store never reopens it", () => {
    const pairing = new PairingStore(dir);
    pairing.offer();
    const claim = claimed(pairing.claimLink());
    mkdirSync(join(dir, "devices.json"));
    expect(admitPairing(claim, new DeviceStore(dir), generateX25519().publicKey, "phone").ok).toBe(false);
    expect("refused" in pairing.claimLink()).toBe(true);
    expect(existsSync(join(dir, "pairing.json"))).toBe(false);
  });

  test("only the first confirmed handshake is admitted, across the two kinds", () => {
    const pairing = new PairingStore(dir);
    const devices = new DeviceStore(dir);
    const offer = pairing.offer();
    const byCode = claimed(pairing.claimCode(pairingSlotOf(offer.code)));
    const byLink = claimed(pairing.claimLink());
    expect(admitPairing(byLink, devices, generateX25519().publicKey, "a")).toEqual({ ok: true });
    expect(admitPairing(byCode, devices, generateX25519().publicKey, "b")).toMatchObject({ ok: false, code: 4401 });
    expect(devices.list().map((device) => device.name)).toEqual(["a"]);
  });

  test("a pairing confirmed after the offer expired is refused and the offer removed", () => {
    const pairing = new PairingStore(dir);
    const offer = pairing.offer(0);
    expect(claimed(pairing.claimLink(1)).complete(offer.expiresAt)).toBe(false);
    expect(existsSync(join(dir, "pairing.json"))).toBe(false);
  });

  test("settling an old claim leaves a newer offer alone", () => {
    const pairing = new PairingStore(dir);
    pairing.offer();
    const claim = claimed(pairing.claimLink());
    const replacement = new PairingStore(dir).offer();
    expect(admitPairing(claim, new DeviceStore(dir), generateX25519().publicKey, "a")).toEqual({ ok: true });
    expect(pairing.read()?.code).toBe(replacement.code);
  });

  test("a mesh claim taken before its offer was withdrawn is never spent, so it cannot admit later", () => {
    const pairing = new PairingStore(dir);
    pairing.offer(Date.now(), true);
    const claim = claimed(pairing.claimLink(Date.now(), true));
    expect(new PairingStore(dir).withdrawMesh()).toBe(true);
    expect(claim.complete()).toBe(false);
  });

  test("withdrawing leaves a device offer open", () => {
    const pairing = new PairingStore(dir);
    const offer = pairing.offer();
    expect(pairing.withdrawMesh()).toBe(false);
    expect(pairing.read()?.code).toBe(offer.code);
  });
});

describe("typed-code attempt reservations", () => {
  test(`each answered attempt is counted; the ${PAIRING_CODE_ATTEMPTS}th retires the code and the next is refused 4429`, () => {
    const pairing = new PairingStore(dir);
    const slot = pairingSlotOf(pairing.offer().code);
    const claims = Array.from({ length: PAIRING_CODE_ATTEMPTS }, () => claimed(pairing.claimCode(slot)));
    expect(attempts(pairing)).toBe(PAIRING_CODE_ATTEMPTS);
    expect(claims.map((claim) => claim.retiredCode)).toEqual([...Array(9).fill(false), true]);
    expect(pairing.claimCode(slot)).toMatchObject({ refused: 4429 });
    expect("secret" in pairing.claimLink()).toBe(true);
  });

  test("a claim while another process holds the lock mid-reservation waits for it instead of reserving beside it", async () => {
    const pairing = new PairingStore(dir, () => {}, { lockTimeoutMs: 50 });
    const slot = pairingSlotOf(pairing.offer().code);
    for (let i = 0; i < PAIRING_CODE_ATTEMPTS - 1; i++) claimed(pairing.claimCode(slot));
    const other = Bun.spawn([process.execPath, RESERVATION_WORKER, dir], { stdin: "pipe", stdout: "pipe" });
    const reader = other.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
    expect(() => pairing.claimCode(slot)).toThrow("locked");
    other.stdin.write("go");
    await other.stdin.end();
    expect(await other.exited).toBe(0);
    expect(attempts(pairing)).toBe(PAIRING_CODE_ATTEMPTS);
    expect(pairing.claimCode(slot)).toMatchObject({ refused: 4429 });
  }, 10_000);

  test("the count survives a host restart", () => {
    const slot = pairingSlotOf(new PairingStore(dir).offer().code);
    const before = new PairingStore(dir);
    for (let i = 0; i < PAIRING_CODE_ATTEMPTS - 1; i++) claimed(before.claimCode(slot));
    const after = new PairingStore(dir);
    expect(claimed(after.claimCode(slot)).retiredCode).toBe(true);
    expect(after.claimCode(slot)).toMatchObject({ refused: 4429 });
  });

  test("the count spans a slot redraw: it is per offer, not per code", () => {
    const pairing = new PairingStore(dir);
    const offer = pairing.offer();
    claimed(pairing.claimCode(pairingSlotOf(offer.code)));
    const redrawn = pairing.redraw(offer.code);
    expect([redrawn?.codeAttempts, redrawn?.linkSecret]).toEqual([1, offer.linkSecret]);
  });

  test("another slot, no offer, or an expired offer is refused 4401 and counts nothing", () => {
    const pairing = new PairingStore(dir);
    expect(pairing.claimCode("ABC")).toMatchObject({ refused: 4401 });
    const offer = pairing.offer(0);
    const other = pairingSlotOf(offer.code) === "ZZZ" ? "YYY" : "ZZZ";
    expect(pairing.claimCode(other, 1)).toMatchObject({ refused: 4401 });
    expect(attempts(pairing)).toBe(0);
    expect(pairing.claimCode(pairingSlotOf(offer.code), offer.expiresAt)).toMatchObject({ refused: 4401 });
    expect(existsSync(join(dir, "pairing.json"))).toBe(false);
  });

  test("a reservation that cannot be written throws, so the caller can answer nothing", () => {
    const pairing = new PairingStore(dir);
    const slot = pairingSlotOf(pairing.offer().code);
    chmodSync(dir, 0o500);
    expect(() => pairing.claimCode(slot)).toThrow();
    chmodSync(dir, 0o700);
    expect(attempts(pairing)).toBe(0);
  });
});

describe("pairing.json format", () => {
  test("an offer written by an older host (version 2) is discarded with a log line", () => {
    writeFileSync(
      join(dir, "pairing.json"),
      JSON.stringify({ version: 2, code: "7KQ39D2M", expiresAt: "2099-01-01T00:00:00Z", slot: "pending" }),
    );
    const lines: string[] = [];
    const pairing = new PairingStore(dir, (line) => lines.push(line));
    expect(pairing.claimCode("7KQ")).toMatchObject({ refused: 4401 });
    expect(existsSync(join(dir, "pairing.json"))).toBe(false);
    expect(lines).toEqual(["pairing offer from an older doriface-host discarded; run doriface-host pair again"]);
  });
});
