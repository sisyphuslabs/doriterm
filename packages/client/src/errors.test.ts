import { expect, test } from "bun:test";
import { HcCoreMismatchError, HcHandshakeError, HcHandshakeTimeoutError } from "./errors.ts";
import { GENERATION } from "./hello.ts";

test("a hello deadline names itself, so a caller can tell a silence from an answer it cannot use (#744)", () => {
  const error = new HcHandshakeTimeoutError(290);
  expect(error.name).toBe("HcHandshakeTimeoutError");
  expect(error.timeoutMs).toBe(290);
  expect(error.message).toBe("no hello reply within 290 ms");
  expect(error).toBeInstanceOf(HcHandshakeError);
});

test("a core mismatch names itself, so logs and reports do not call it a plain handshake failure (#651)", () => {
  const error = new HcCoreMismatchError({ kind: "core-newer", generation: GENERATION + 1 });
  expect(error.name).toBe("HcCoreMismatchError");
  expect(error).toBeInstanceOf(HcHandshakeError);
});

test("a generation mismatch states this client's generation from the one constant the handshake checks (#651)", () => {
  const error = new HcCoreMismatchError({ kind: "core-older", generation: GENERATION - 1, need: "0.1.17" });
  expect(error.message).toBe(`core speaks protocol generation ${GENERATION - 1}, this client ${GENERATION}`);
});
