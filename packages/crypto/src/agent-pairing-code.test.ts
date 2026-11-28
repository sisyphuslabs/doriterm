import { expect, test } from "bun:test";
import { agentPairingCode } from "./pairing-keys.ts";

test("the agent pairing code is six digits grouped 3+3, fixed by the handshake hash and different for another", () => {
  const hash = new Uint8Array(32).fill(7);
  const other = new Uint8Array(32).fill(8);
  expect(agentPairingCode(hash)).toMatch(/^\d{3} \d{3}$/);
  expect(agentPairingCode(hash)).toBe(agentPairingCode(Uint8Array.from(hash)));
  expect(agentPairingCode(other)).not.toBe(agentPairingCode(hash));
});
