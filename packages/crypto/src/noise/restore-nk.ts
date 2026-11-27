import { x25519 } from "@noble/curves/ed25519.js";
import { concatBytes, utf8 } from "../encoding.ts";
import { generateX25519, type KeyPair } from "../identity.ts";
import type { StaticKey } from "../static-key.ts";
import { type CipherState, TAG_LENGTH } from "./cipher-state.ts";
import { SymmetricState } from "./symmetric-state.ts";

const PROTOCOL = "Noise_NK_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE = utf8("doriterm restore v1");
const EMPTY = new Uint8Array(0);
const KEY_BYTES = 32;
export const RESTORE_CHALLENGE_BYTES = 32;
export const RESTORE_FIRST_BYTES = KEY_BYTES + TAG_LENGTH;
export const RESTORE_SECOND_BYTES = KEY_BYTES + TAG_LENGTH + RESTORE_CHALLENGE_BYTES;

interface Ciphers {
  readonly send: CipherState;
  readonly receive: CipherState;
}

function initialize(holderKey: Uint8Array): SymmetricState {
  const state = new SymmetricState(PROTOCOL);
  state.mixHash(PROLOGUE);
  state.mixHash(holderKey);
  return state;
}

/** Noise NK: -> e, es; <- e, ee. There is no initiator static key to reveal to the holder or restore. */
export function openRestoreNoise(
  holderKey: Uint8Array,
  ephemeral = generateX25519(),
): {
  readonly first: Uint8Array;
  finish(second: Uint8Array): Ciphers & { readonly challenge: Uint8Array };
} {
  const state = initialize(holderKey);
  state.mixHash(ephemeral.publicKey);
  state.mixKey(x25519.getSharedSecret(ephemeral.secretKey, holderKey));
  const first = concatBytes(ephemeral.publicKey, state.encryptAndHash(EMPTY));
  let finished = false;
  return {
    first,
    finish(second) {
      if (finished) throw new Error("the restore handshake has ended");
      finished = true;
      if (second.byteLength !== RESTORE_SECOND_BYTES) throw new Error("invalid restore handshake response");
      const peer = second.subarray(0, KEY_BYTES);
      state.mixHash(peer);
      state.mixKey(x25519.getSharedSecret(ephemeral.secretKey, peer));
      const challenge = state.decryptAndHash(second.subarray(KEY_BYTES));
      const [send, receive] = state.split();
      return { challenge, send, receive };
    },
  };
}

export async function answerRestoreNoise(
  holder: StaticKey,
  first: Uint8Array,
  challenge: Uint8Array,
): Promise<Ciphers & { readonly second: Uint8Array }> {
  if (first.byteLength !== RESTORE_FIRST_BYTES || challenge.byteLength !== RESTORE_CHALLENGE_BYTES)
    throw new Error("invalid restore handshake request");
  const peer = first.subarray(0, KEY_BYTES);
  const state = initialize(holder.publicKey);
  state.mixHash(peer);
  state.mixKey(await holder.dh(peer));
  state.decryptAndHash(first.subarray(KEY_BYTES));
  const ephemeral: KeyPair = generateX25519();
  state.mixHash(ephemeral.publicKey);
  state.mixKey(x25519.getSharedSecret(ephemeral.secretKey, peer));
  const second = concatBytes(ephemeral.publicKey, state.encryptAndHash(challenge));
  const [receive, send] = state.split();
  return { second, send, receive };
}
