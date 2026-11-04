import { closeCodeOf } from "@doriface/crypto";
import { CloseCode, type RelayProofs, relayOriginOf } from "@doriface/relay-client";

/** How long a dial refused for its pass (4412) waits for the new pass before it redials (contract v1.6, 3.6). */
export const PASS_WAIT_MS = 2_000;

function newPass(proofs: RelayProofs, relayUrl: string, ms: number): Promise<void> {
  const origin = relayOriginOf(relayUrl);
  return new Promise((resolve) => {
    const stop = proofs.onPass((arrived) => {
      if (arrived !== origin) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, ms);
  });
}

const codeOf = (error: unknown): number | undefined => (error instanceof Error ? closeCodeOf(error) : undefined);

/**
 * Contract v1.6, 3.6: a dial whose pass the relay refused (4412) waits up to 2 s for the new pass the uplink asked for,
 * then redials once, with a proof if one arrived. An address limit an unproven redial meets is the refused pass's doing,
 * not the target's, so the caller sees the original 4412: no gate and no halving.
 */
export async function withPassRetry<T>(
  dial: () => Promise<T>,
  proofs: RelayProofs | undefined,
  relayUrl: string,
  waitMs: number = PASS_WAIT_MS,
): Promise<T> {
  // A 4412 on a dial that carried no proof is no pass refusal (only a faulty stand-in sends one): no retry (J4).
  const proven = proofs?.presents(relayOriginOf(relayUrl)) === true;
  try {
    return await dial();
  } catch (error) {
    if (proofs === undefined || !proven || codeOf(error) !== CloseCode.PassRefused) throw error;
    proofs.refused(relayOriginOf(relayUrl));
    await newPass(proofs, relayUrl, waitMs);
    return dial().catch((again: unknown) => {
      throw codeOf(again) === CloseCode.RateLimited ? error : again;
    });
  }
}
