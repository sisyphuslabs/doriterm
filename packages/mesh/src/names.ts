// herdr-core's machine-name rule (kept in @doriface/crypto, which checks it at the handshake) and the mesh fallback names.

export { checkName, idShaped } from "@doriface/crypto";

export const FALLBACK_LENGTHS = [4, 8, 12] as const;

/** `<name cut to 31-k>-<first k hostId characters>` for k = 4, 8, 12, in order. */
export const fallbacks = (name: string, hostId: string): readonly string[] =>
  FALLBACK_LENGTHS.map((k) => `${name.slice(0, 31 - k)}-${hostId.slice(0, k)}`);
